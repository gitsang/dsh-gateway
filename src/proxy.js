import { request as httpRequest } from 'node:http'
import { injectPwaTags } from './pwa.js'

/**
 * Parse a Cookie request header into a plain object. Only the first `name=`
 * occurrence wins; duplicates are ignored.
 */
export function parseCookies(header) {
  const cookies = {}
  if (typeof header !== 'string' || header === '') return cookies
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const name = part.slice(0, index).trim()
    if (name === '') continue
    cookies[name] = part.slice(index + 1).trim()
  }
  return cookies
}

/** Headers that must not be forwarded as-is by a proxy. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

function filterHopByHop(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}

/**
 * Forward one HTTP request to the dsh web server and pipe the response back.
 *
 * When `options.pwa` is true (the default) and the upstream response is
 * uncompressed HTML, the PWA tags are injected into the head before the
 * response is sent back. Everything else is streamed through untouched.
 */
export function proxyRequest(req, res, target, options = {}) {
  const { pwa = true } = options
  const upstream = httpRequest({
    hostname: target.host,
    port: target.port,
    path: req.url,
    method: req.method,
    headers: filterHopByHop(req.headers)
  }, (upstreamRes) => {
    const statusCode = upstreamRes.statusCode ?? 502
    const contentType = String(upstreamRes.headers['content-type'] ?? '')
    const canInject = pwa &&
      req.method === 'GET' &&
      statusCode === 200 &&
      contentType.includes('text/html') &&
      !upstreamRes.headers['content-encoding']

    if (canInject) {
      const chunks = []
      upstreamRes.on('data', (chunk) => chunks.push(chunk))
      upstreamRes.on('end', () => {
        const headers = { ...upstreamRes.headers }
        delete headers['transfer-encoding']
        const body = injectPwaTags(Buffer.concat(chunks).toString('utf8'))
        headers['content-length'] = Buffer.byteLength(body)
        res.writeHead(statusCode, upstreamRes.statusMessage, headers)
        res.end(body)
      })
      upstreamRes.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502, {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'close'
          })
          res.end(`dsh-web-auth: upstream response error: ${err.message}`)
          return
        }
        res.destroy()
      })
      return
    }

    res.writeHead(statusCode, upstreamRes.statusMessage, upstreamRes.headers)
    upstreamRes.pipe(res)
  })

  upstream.on('error', (err) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(502, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'close'
    })
    res.end(`dsh-web-auth: upstream unavailable: ${err.message}`)
  })

  req.pipe(upstream)
}

/**
 * Forward a WebSocket upgrade to the dsh web server. The caller has already
 * checked the session token; this only pipes bytes after that gate.
 */
export function proxyUpgrade(req, socket, head, target) {
  const headers = { ...req.headers }
  delete headers['proxy-authorization']
  delete headers['proxy-authenticate']

  const upstream = httpRequest({
    hostname: target.host,
    port: target.port,
    path: req.url,
    method: 'GET',
    headers
  })

  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/${upstreamRes.httpVersion} ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`
    let headText = statusLine
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (value === undefined) continue
      headText += `${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`
    }
    headText += '\r\n'
    socket.write(headText)
    if (upstreamHead && upstreamHead.length > 0) socket.write(upstreamHead)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)

    const teardown = () => {
      upstreamSocket.destroy()
      socket.destroy()
    }
    upstreamSocket.on('error', teardown)
    socket.on('error', teardown)
    upstreamSocket.on('close', () => socket.destroy())
    socket.on('close', () => upstreamSocket.destroy())
  })

  upstream.on('error', () => {
    socket.destroy()
  })

  upstream.end()
}
