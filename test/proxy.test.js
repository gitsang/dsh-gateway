import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import test from 'node:test'
import { applyCachePolicy, isImmutableAssetUrl, loopbackHeaders, proxyRequest, proxyUpgrade, rewriteResponseHeaders, targetAuthority } from '../src/proxy.js'
import { UpstreamAuth } from '../src/upstream-auth.js'
import { PWA_HEAD_TAGS, SW_DISABLED_JS, SW_JS } from '../src/pwa.js'

test('targetAuthority renders a canonical upstream authority', () => {
  assert.equal(targetAuthority({ host: '127.0.0.1', port: 3080 }), '127.0.0.1:3080')
  assert.equal(targetAuthority({ host: '::1', port: 3080 }), '[::1]:3080')
})

test('loopbackHeaders rewrites browser identity but preserves CSRF metadata', () => {
  const headers = loopbackHeaders({
    host: 'dsh.example.com',
    origin: 'https://dsh.example.com',
    referer: 'https://dsh.example.com/settings?tab=models',
    'sec-fetch-site': 'cross-site',
    'x-forwarded-for': '203.0.113.9',
    'x-forwarded-host': 'dsh.example.com',
    'x-forwarded-port': '443',
    'x-forwarded-proto': 'https',
    'x-real-ip': '203.0.113.9',
    forwarded: 'for=203.0.113.9;host="dsh.example.com";proto=https'
  }, { host: '127.0.0.1', port: 3080 })

  assert.equal(headers.host, '127.0.0.1:3080')
  assert.equal(headers.origin, 'http://127.0.0.1:3080')
  assert.equal(headers.referer, 'http://127.0.0.1:3080/settings?tab=models')
  assert.equal(headers['sec-fetch-site'], 'cross-site')
  assert.equal(headers['x-forwarded-for'], '127.0.0.1')
  assert.equal(headers['x-forwarded-host'], '127.0.0.1:3080')
  assert.equal(headers['x-forwarded-port'], '3080')
  assert.equal(headers['x-forwarded-proto'], 'http')
  assert.equal(headers['x-real-ip'], '127.0.0.1')
  assert.equal(headers.forwarded, 'for=127.0.0.1;host="127.0.0.1:3080";proto=http')
})

test('rewriteResponseHeaders maps loopback redirects back to the public origin', () => {
  const req = {
    headers: {
      host: 'dsh.example.com',
      origin: 'https://dsh.example.com',
      'x-forwarded-proto': 'https'
    }
  }
  const headers = rewriteResponseHeaders({
    location: 'http://127.0.0.1:3080/login?next=%2Fsettings',
    'set-cookie': [
      'dsh-auth-loopback=server-secret; Path=/',
      'plugin_pref=keep-me; Path=/'
    ]
  }, req, { host: '127.0.0.1', port: 3080 })

  assert.equal(headers.location, 'https://dsh.example.com/login?next=%2Fsettings')
  assert.deepEqual(headers['set-cookie'], ['plugin_pref=keep-me; Path=/'])
})

test('rewriteResponseHeaders leaves relative locations and unrelated cookies alone', () => {
  const headers = rewriteResponseHeaders({
    location: './settings',
    'set-cookie': 'plugin_pref=keep-me; Path=/'
  }, {
    headers: { host: 'dsh.example.com', 'x-forwarded-proto': 'https' }
  }, { host: '127.0.0.1', port: 3080 })

  assert.equal(headers.location, './settings')
  assert.equal(headers['set-cookie'], 'plugin_pref=keep-me; Path=/')
})

test('proxyRequest forwards loopback identity and the redeemed session cookie', async (t) => {
  let seen
  const upstream = createServer((req, res) => {
    seen = req.headers
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => upstream.close())

  const target = { host: '127.0.0.1', port: upstream.address().port }
  const front = createServer((req, res) => {
    proxyRequest(req, res, target, {
      pwa: false,
      hostMode: false,
      sessionCookie: 'dsh-auth-local=value'
    }).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  front.listen(0, '127.0.0.1')
  await once(front, 'listening')
  t.after(() => front.close())

  const response = await fetch(`http://127.0.0.1:${front.address().port}/api/echo`, {
    method: 'POST',
    headers: {
      host: 'dsh.example.com',
      origin: 'https://dsh.example.com',
      referer: 'https://dsh.example.com/ui',
      cookie: 'dsh_web_session=password-ok; dsh-auth-public=stale',
      'content-type': 'text/plain'
    },
    body: 'hello'
  })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'ok')
  assert.equal(seen.host, `127.0.0.1:${target.port}`)
  assert.equal(seen.origin, `http://127.0.0.1:${target.port}`)
  assert.equal(seen.referer, `http://127.0.0.1:${target.port}/ui`)
  assert.equal(seen.cookie, 'dsh-auth-local=value')
})

test('proxyUpgrade forwards loopback identity for WebSocket streams', async (t) => {
  let seen
  const upstream = createServer((req, res) => {
    res.writeHead(404)
    res.end()
  })
  upstream.on('upgrade', (req, socket) => {
    seen = req.headers
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => upstream.close())

  const target = { host: '127.0.0.1', port: upstream.address().port }
  const front = createServer()
  front.on('upgrade', (req, socket, head) => {
    proxyUpgrade(req, socket, head, target, { sessionCookie: 'dsh-auth-local=value' })
  })
  front.listen(0, '127.0.0.1')
  await once(front, 'listening')
  t.after(() => front.close())

  const socket = connect(front.address().port, '127.0.0.1')
  await once(socket, 'connect')
  const response = new Promise((resolve) => {
    let data = ''
    socket.on('data', (chunk) => { data += chunk })
    socket.on('close', () => resolve(data))
  })
  socket.write([
    'GET /api/stream HTTP/1.1',
    'Host: dsh.example.com',
    'Origin: https://dsh.example.com',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    'Cookie: dsh_web_session=password-ok; dsh-auth-public=stale',
    '', ''
  ].join('\r\n'))

  assert.match(await response, /^HTTP\/1\.1 101/)
  assert.equal(seen.host, `127.0.0.1:${target.port}`)
  assert.equal(seen.origin, `http://127.0.0.1:${target.port}`)
  assert.equal(seen.cookie, 'dsh-auth-local=value')
})

test('UpstreamAuth redeems and caches a cookie for the loopback authority', async (t) => {
  const upstream = createServer((req, res) => {
    assert.equal(req.headers.host, targetAuthority(target))
    if (req.url.startsWith('/?token=launch-token')) {
      const authority = req.headers.host
      const name = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
      res.writeHead(303, { location: './', 'set-cookie': `${name}=cookie-for-loopback; Path=/` })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('authenticated')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => upstream.close())

  const target = { host: '127.0.0.1', port: upstream.address().port }
  const authority = targetAuthority(target)
  const cookie = await new UpstreamAuth(
    target,
    (value) => `http://${value}/?token=launch-token`
  ).cookieFor(authority)
  assert.match(cookie, /^dsh-auth-/)
})


test('immutable assets are detected by content hash or plugin revision', () => {
  assert.equal(isImmutableAssetUrl('/assets/index-5SrrfWpU.js'), true)
  assert.equal(isImmutableAssetUrl('/assets/vendor-BNsW4eBh.css?x=1'), true)
  assert.equal(isImmutableAssetUrl('/plugins/??@scope/pkg/client.js&rev=67ec353e7a50'), true)
  assert.equal(isImmutableAssetUrl('/plugins/@scope/pkg/client.js?rev=abc'), true)
  assert.equal(isImmutableAssetUrl('/plugins/@scope/pkg/client.js'), false)
  assert.equal(isImmutableAssetUrl('/'), false)
})

test('applyCachePolicy marks assets immutable and keeps HTML revalidated', () => {
  const asset = applyCachePolicy(
    { url: '/assets/index-5SrrfWpU.js' },
    { 'content-type': 'text/javascript; charset=utf-8' }
  )
  assert.equal(asset['cache-control'], 'public, max-age=31536000, immutable')

  const plugin = applyCachePolicy(
    { url: '/plugins/??a/client.js&rev=abc' },
    { 'content-type': 'text/javascript; charset=utf-8' }
  )
  assert.equal(plugin['cache-control'], 'public, max-age=31536000, immutable')

  const html = applyCachePolicy(
    { url: '/' },
    { 'content-type': 'text/html; charset=utf-8', vary: 'Accept-Encoding' }
  )
  assert.equal(html['cache-control'], 'private, no-cache')
  assert.equal(html.vary, 'Accept-Encoding, Cookie')

  const api = applyCachePolicy(
    { url: '/api/rpc' },
    { 'content-type': 'application/json' }
  )
  assert.equal(api['cache-control'], 'no-store')

  const missing = applyCachePolicy(
    { url: '/assets/missing-abc.js' },
    { 'content-type': 'text/plain' },
    404
  )
  assert.equal(missing['cache-control'], 'no-store')
})

test('the service worker caches the shell and hashed assets but never API traffic', () => {
  assert.doesNotThrow(() => new Function(SW_JS))
  assert.match(SW_JS, /dsh-gateway-assets-v1/)
  assert.match(SW_JS, /dsh-gateway-shell-v1/)
  assert.match(SW_JS, /url\.pathname === '\/api' \|\| url\.pathname\.startsWith\('\/api\/'\)/)
  assert.match(SW_JS, /event\.waitUntil\(network\.catch/)
  assert.match(PWA_HEAD_TAGS, /updateViaCache: 'none'/)
  assert.match(PWA_HEAD_TAGS, /key\.destination === 'document'/)
  assert.doesNotThrow(() => new Function(SW_DISABLED_JS))
  assert.match(SW_DISABLED_JS, /self\.registration\.unregister\(\)/)
  assert.match(SW_DISABLED_JS, /dsh-web-auth-/)
})


test('proxyRequest adds HTTP cache headers by resource class', async (t) => {
  const upstream = createServer((req, res) => {
    if (req.url === '/assets/index-abc.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end('console.log(1)')
      return
    }
    if (req.url === '/api/rpc') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', vary: 'Accept-Encoding' })
    res.end('<!doctype html><html><head></head><body>ok</body></html>')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => upstream.close())

  const target = { host: '127.0.0.1', port: upstream.address().port }
  const front = createServer((req, res) => {
    proxyRequest(req, res, target, { pwa: false, hostMode: false }).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  front.listen(0, '127.0.0.1')
  await once(front, 'listening')
  t.after(() => front.close())
  const base = `http://127.0.0.1:${front.address().port}`

  const asset = await fetch(`${base}/assets/index-abc.js`)
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')

  const api = await fetch(`${base}/api/rpc`)
  assert.equal(api.headers.get('cache-control'), 'no-store')

  const html = await fetch(`${base}/`)
  assert.equal(html.headers.get('cache-control'), 'private, no-cache')
  assert.match(html.headers.get('vary') ?? '', /Cookie/)
})
