import { request as httpRequest } from 'node:http'
import { injectHostModeTag, injectPwaTags } from './pwa.js'

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
 * The cookie prefix dsh uses for its signed browser-session cookies
 * (`dsh-auth-<base64url sha256 of the request authority>`).
 */
export const DSH_COOKIE_PREFIX = 'dsh-auth-'

/**
 * Return a copy of `headers` whose Cookie header holds only cookies that are
 * safe to forward, plus `sessionCookie` when one was supplied.
 *
 * Every `dsh-auth-*` cookie the browser holds is dropped: its name encodes the
 * authority that minted it, which is generally *not* the authority we forward
 * on, so relaying it can only lead dsh to reject the request.
 */
function replaceSessionCookie(headers, sessionCookie) {
  const out = { ...headers }
  const raw = out.cookie
  const kept = typeof raw === 'string'
    ? raw.split(';')
      .map((segment) => segment.trim())
      .filter((segment) => segment !== '' && !segment.startsWith(DSH_COOKIE_PREFIX))
    : []
  if (sessionCookie !== undefined) kept.push(sessionCookie)
  if (kept.length === 0) delete out.cookie
  else out.cookie = kept.join('; ')
  return out
}

/**
 * Whether a response is dsh's browser-session rejection rather than some other
 * 401. dsh answers a missing/expired cookie with a fixed plain-text body; only
 * that reply is worth re-authenticating for.
 */
function isDshAuthRejection(upstreamRes, body) {
  return upstreamRes.statusCode === 401 &&
    String(upstreamRes.headers['content-type'] ?? '').includes('text/plain') &&
    body.includes('dsh web authentication required')
}

/** Bodies larger than this are streamed rather than buffered for a retry. */
const BUFFER_LIMIT_BYTES = 1 << 20

/**
 * Read a whole request body into memory. Returns undefined when the body
 * exceeds `limit` (the caller then streams the request instead of retrying it).
 */
function bufferRequest(req, limit) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let overflowed = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) overflowed = true
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(overflowed ? undefined : Buffer.concat(chunks)))
    req.on('error', () => resolve(undefined))
  })
}

/** A request method that carries no body. */
function hasNoBody(method) {
  return method === 'GET' || method === 'HEAD'
}

/** Whether this request/response pair is one we rewrite before relaying. */
function wantsRewrite(req, upstreamRes, options) {
  if (req.method !== 'GET') return false
  if ((upstreamRes.statusCode ?? 0) !== 200) return false
  if (!String(upstreamRes.headers['content-type'] ?? '').includes('text/html')) return false
  // A compressed body cannot be patched in place; send() drops Accept-Encoding
  // for document navigations so this should always hold.
  if (upstreamRes.headers['content-encoding'] !== undefined) return false
  return options.pwa !== false || options.hostMode === true
}

/**
 * Write one upstream response to the client, rewriting plain uncompressed HTML
 * when enabled: PWA tags for the installable shell, and the Host-mode
 * transport flag that lets the remote page use Host settings. Everything else
 * streams through untouched.
 */
function relay(req, upstreamRes, res, options) {
  const { method } = options
  const statusCode = upstreamRes.statusCode ?? 502

  if (!wantsRewrite(req, upstreamRes, options)) {
    res.writeHead(statusCode, upstreamRes.statusMessage, upstreamRes.headers)
    upstreamRes.pipe(res)
    return
  }

  const chunks = []
  upstreamRes.on('data', (chunk) => chunks.push(chunk))
  upstreamRes.on('end', () => {
    const headers = { ...upstreamRes.headers }
    delete headers['transfer-encoding']
    let body = Buffer.concat(chunks).toString('utf8')
    // Host mode first: it must precede every dsh script in the head.
    if (options.hostMode === true) body = injectHostModeTag(body)
    if (options.pwa !== false) body = injectPwaTags(body)
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
}

/**
 * Whether a request is a top-level HTML navigation whose body we may rewrite.
 * Mirrors the headers dsh's own compression middleware keys on.
 * @param req - the incoming browser request.
 * @returns true for a document GET/HEAD that accepts HTML.
 */
function isDocumentNavigation(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (!String(req.headers.accept ?? '').includes('text/html')) return false
  const dest = req.headers['sec-fetch-dest']
  return dest === undefined || dest === 'document' || dest === 'iframe'
}

/** Issue one request to dsh; resolves with its response or rejects. */
function send(target, req, options, body) {
  return new Promise((resolve, reject) => {
    const headers = replaceSessionCookie(filterHopByHop(req.headers), options.sessionCookie)
    // dsh gzips HTML documents only for real browser navigations (Accept:
    // text/html + Sec-Fetch-Dest: document). A compressed body cannot be
    // rewritten, so ask for identity on exactly those requests; stylesheets,
    // scripts and API payloads keep their compression.
    const rewritesHtml = options.pwa !== false || options.hostMode === true
    if (rewritesHtml && isDocumentNavigation(req)) {
      delete headers['accept-encoding']
    }
    if (body !== undefined) headers['content-length'] = String(body.length)
    const upstream = httpRequest({
      hostname: target.host,
      port: target.port,
      path: req.url,
      method: req.method,
      headers
    }, resolve)
    upstream.on('error', reject)
    if (body === undefined) req.pipe(upstream)
    else upstream.end(body)
  })
}

/** Report an upstream connection failure to the client. */
function fail(res, message) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(502, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close'
  })
  res.end(`dsh-web-auth: upstream unavailable: ${message}`)
}

/**
 * Forward one HTTP request to the dsh web server and pipe the response back.
 *
 * When `options.pwa` is true (the default) and the upstream response is
 * uncompressed HTML, the PWA tags are injected into the head before the
 * response is sent back. Everything else is streamed through untouched.
 *
 * `options.sessionCookie` is the `dsh-auth-…` pair the proxy redeemed for this
 * request's authority; it replaces whatever session cookie the browser sent.
 * `options.reauthorize` returns a replacement pair when dsh rejects that cookie
 * (it expired, or dsh restarted with a new launch token), letting the proxy
 * retry once instead of handing the user a 401 they cannot act on. It may
 * return a promise.
 */
export async function proxyRequest(req, res, target, options = {}) {
  const body = hasNoBody(req.method) ? undefined : await bufferRequest(req, BUFFER_LIMIT_BYTES)
  // A streamed (unbuffered) body cannot be replayed, so it gets no retry.
  let canRetry = body !== undefined && options.reauthorize !== undefined

  let sessionCookie = options.sessionCookie
  for (;;) {
    let upstreamRes
    try {
      upstreamRes = await send(target, req, { ...options, sessionCookie }, body)
    } catch (error) {
      fail(res, error?.message ?? error)
      return
    }

    if (canRetry && upstreamRes.statusCode === 401) {
      // Buffer only the small rejection reply; a real 401 payload is tiny.
      const chunks = []
      let size = 0
      await new Promise((resolve) => {
        upstreamRes.on('data', (chunk) => {
          size += chunk.length
          if (size <= 8192) chunks.push(chunk)
        })
        upstreamRes.once('end', resolve)
        upstreamRes.once('error', resolve)
      })
      if (isDshAuthRejection(upstreamRes, Buffer.concat(chunks).toString('utf8'))) {
        canRetry = false
        sessionCookie = await options.reauthorize()
        continue
      }
      // Some other 401: replay the buffered reply to the client verbatim.
      const headers = { ...upstreamRes.headers }
      delete headers['transfer-encoding']
      headers['content-length'] = String(Buffer.concat(chunks).length)
      res.writeHead(401, upstreamRes.statusMessage, headers)
      res.end(Buffer.concat(chunks))
      return
    }

    relay(req, upstreamRes, res, { ...options, sessionCookie })
    return
  }
}

/**
 * Forward a WebSocket upgrade to the dsh web server. The caller has already
 * checked the session token; this only pipes bytes after that gate.
 */
export function proxyUpgrade(req, socket, head, target, options = {}) {
  // Keep Upgrade/Connection: they are what makes this an upgrade rather than an
  // ordinary GET. Only the browser's dsh session cookie is replaced with the
  // one redeemed for this authority.
  const headers = replaceSessionCookie(req.headers, options.sessionCookie)
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
