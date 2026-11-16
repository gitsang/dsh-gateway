import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import test from 'node:test'
import {
  applyCachePolicy,
  dshCookieName,
  isDshAuthRejection,
  isImmutableAssetUrl,
  loopbackHeaders,
  probeBrowserSession,
  proxyRequest,
  proxyUpgrade,
  rewriteResponseHeaders,
  targetAuthority
} from '../src/proxy.js'
import { PWA_HEAD_TAGS, SW_DISABLED_JS, SW_JS } from '../src/pwa.js'

test('targetAuthority renders a canonical upstream authority', () => {
  assert.equal(targetAuthority({ host: '127.0.0.1', port: 3080 }), '127.0.0.1:3080')
  assert.equal(targetAuthority({ host: '::1', port: 3080 }), '[::1]:3080')
})

test('dshCookieName matches the name dsh derives from the authority', () => {
  const authority = '127.0.0.1:3080'
  const expected = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
  assert.equal(dshCookieName(authority), expected)
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
    'set-cookie': ['plugin_pref=keep-me; Path=/']
  }, req, { host: '127.0.0.1', port: 3080 })

  assert.equal(headers.location, 'https://dsh.example.com/login?next=%2Fsettings')
  assert.deepEqual(headers['set-cookie'], ['plugin_pref=keep-me; Path=/'])
})

test('rewriteResponseHeaders leaves relative locations alone', () => {
  const headers = rewriteResponseHeaders({
    location: './settings',
    'set-cookie': 'plugin_pref=keep-me; Path=/'
  }, {
    headers: { host: 'dsh.example.com', 'x-forwarded-proto': 'https' }
  }, { host: '127.0.0.1', port: 3080 })

  assert.equal(headers.location, './settings')
  assert.equal(headers['set-cookie'], 'plugin_pref=keep-me; Path=/')
})

test('rewriteResponseHeaders forwards the dsh session cookie unchanged upstream of TLS', () => {
  const cookie = 'dsh-auth-abc=v1.payload.signature; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict'
  const headers = rewriteResponseHeaders({ 'set-cookie': cookie }, {
    headers: { host: '127.0.0.1:3081' }
  }, { host: '127.0.0.1', port: 3080 })

  assert.equal(headers['set-cookie'], cookie)
  assert.doesNotMatch(headers['set-cookie'], /;\s*Secure/i)
})

test('rewriteResponseHeaders adds Secure to the dsh cookie on an HTTPS public hop', () => {
  const cookie = 'dsh-auth-abc=v1.payload.signature; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict'
  const headers = rewriteResponseHeaders({
    'set-cookie': [cookie, 'plugin_pref=keep-me; Path=/']
  }, {
    headers: { host: 'dsh.example.com', 'x-forwarded-proto': 'https' }
  }, { host: '127.0.0.1', port: 3080 })

  assert.equal(headers['set-cookie'][0], `${cookie}; Secure`)
  // Only dsh's own cookie is touched.
  assert.equal(headers['set-cookie'][1], 'plugin_pref=keep-me; Path=/')
})

test('proxyRequest forwards the browser cookie untouched and drops the legacy password cookie', async (t) => {
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
    proxyRequest(req, res, target, { pwa: false, hostMode: false }).catch((error) => {
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
      cookie: 'dsh_gateway_session=dead-token; dsh-auth-local=v1.payload.signature',
      'content-type': 'text/plain'
    },
    body: 'hello'
  })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'ok')
  assert.equal(seen.host, `127.0.0.1:${target.port}`)
  assert.equal(seen.origin, `http://127.0.0.1:${target.port}`)
  assert.equal(seen.referer, `http://127.0.0.1:${target.port}/ui`)
  assert.equal(seen.cookie, 'dsh-auth-local=v1.payload.signature')
})

test('proxyRequest relays a dsh Set-Cookie to the browser', async (t) => {
  const cookie = 'dsh-auth-local=v1.payload.signature; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict'
  const upstream = createServer((req, res) => {
    res.writeHead(303, { location: './', 'set-cookie': cookie })
    res.end()
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => upstream.close())

  const target = { host: '127.0.0.1', port: upstream.address().port }
  const front = createServer((req, res) => {
    proxyRequest(req, res, target, { pwa: false, hostMode: false }).catch(() => res.destroy())
  })
  front.listen(0, '127.0.0.1')
  await once(front, 'listening')
  t.after(() => front.close())

  const response = await fetch(`http://127.0.0.1:${front.address().port}/?token=launch`, {
    redirect: 'manual',
    headers: { host: 'dsh.example.com' }
  })
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('set-cookie'), cookie)
})

test('proxyRequest answers a 401 navigation with an explanatory page', async (t) => {
  const upstream = createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => upstream.close())

  const target = { host: '127.0.0.1', port: upstream.address().port }
  const front = createServer((req, res) => {
    proxyRequest(req, res, target, { pwa: false, hostMode: false }).catch(() => res.destroy())
  })
  front.listen(0, '127.0.0.1')
  await once(front, 'listening')
  t.after(() => front.close())

  const response = await fetch(`http://127.0.0.1:${front.address().port}/`, {
    headers: { accept: 'text/html', 'sec-fetch-dest': 'document' }
  })
  assert.equal(response.status, 401)
  assert.match(response.headers.get('content-type') ?? '', /text\/html/)
  const body = await response.text()
  assert.match(body, /需要登录/)
  assert.match(body, /\?token=/)
})

test('proxyRequest relays a non-auth 401 body verbatim', async (t) => {
  const upstream = createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{"error":"plugin says no"}')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => upstream.close())

  const target = { host: '127.0.0.1', port: upstream.address().port }
  const front = createServer((req, res) => {
    proxyRequest(req, res, target, { pwa: false, hostMode: false }).catch(() => res.destroy())
  })
  front.listen(0, '127.0.0.1')
  await once(front, 'listening')
  t.after(() => front.close())

  const response = await fetch(`http://127.0.0.1:${front.address().port}/`, {
    headers: { accept: 'text/html', 'sec-fetch-dest': 'document' }
  })
  assert.equal(response.status, 401)
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  assert.equal(await response.text(), '{"error":"plugin says no"}')
})

test('isDshAuthRejection only matches dsh\'s own plain-text rejection', () => {
  assert.equal(isDshAuthRejection(
    { statusCode: 401, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    'dsh web authentication required; reopen the URL printed by dsh web.\n'
  ), true)
  assert.equal(isDshAuthRejection(
    { statusCode: 401, headers: { 'content-type': 'application/json' } },
    '{"error":"unauthorized"}'
  ), false)
  assert.equal(isDshAuthRejection(
    { statusCode: 403, headers: { 'content-type': 'text/plain' } },
    'dsh web authentication required'
  ), false)
})

test('probeBrowserSession accepts only a cookie dsh answers 200 for', async (t) => {
  const seen = []
  const upstream = createServer((req, res) => {
    seen.push({ method: req.method, host: req.headers.host, cookie: req.headers.cookie })
    if (req.headers.cookie === 'dsh-auth-good=1') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html>')
      return
    }
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('dsh web authentication required')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => upstream.close())

  const target = { host: '127.0.0.1', port: upstream.address().port }
  assert.equal(await probeBrowserSession(target, 'dsh-auth-good=1'), true)
  assert.equal(await probeBrowserSession(target, 'dsh-auth-bad=1'), false)
  assert.equal(await probeBrowserSession(target, undefined), false)
  // It asks dsh under the loopback authority the proxy forwards on.
  assert.deepEqual(seen.map((entry) => entry.method), ['HEAD', 'HEAD', 'HEAD'])
  assert.equal(seen[0].host, targetAuthority(target))
  assert.equal(seen[2].cookie, undefined)
})

test('proxyUpgrade forwards loopback identity and the browser cookie', async (t) => {
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
    proxyUpgrade(req, socket, head, target)
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
    'Cookie: dsh_gateway_session=dead-token; dsh-auth-public=v1.payload.signature',
    '', ''
  ].join('\r\n'))

  assert.match(await response, /^HTTP\/1\.1 101/)
  assert.equal(seen.host, `127.0.0.1:${target.port}`)
  assert.equal(seen.origin, `http://127.0.0.1:${target.port}`)
  assert.equal(seen.cookie, 'dsh-auth-public=v1.payload.signature')
})

test('proxyUpgrade relays a refused upgrade instead of dropping the socket', async (t) => {
  const upstream = createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('dsh web authentication required')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  t.after(() => upstream.close())

  const target = { host: '127.0.0.1', port: upstream.address().port }
  const front = createServer()
  front.on('upgrade', (req, socket, head) => {
    proxyUpgrade(req, socket, head, target)
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
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    '', ''
  ].join('\r\n'))

  const raw = await response
  assert.match(raw, /^HTTP\/1\.1 401/)
  assert.match(raw, /dsh web authentication required/)
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
  // The gateway's own settings API is never cached either.
  assert.match(SW_JS, /url\.pathname\.startsWith\('\/__dsh_gateway\/'\)/)
  // A 401 navigation drops the cached authenticated shell.
  assert.match(SW_JS, /response\.status === 401/)
  assert.match(PWA_HEAD_TAGS, /updateViaCache: 'none'/)
  assert.doesNotMatch(PWA_HEAD_TAGS, /\/login/)
  assert.doesNotThrow(() => new Function(SW_DISABLED_JS))
  assert.match(SW_DISABLED_JS, /self\.registration\.unregister\(\)/)
  assert.match(SW_DISABLED_JS, /dsh-gateway-/)
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
