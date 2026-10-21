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

/**
 * Drop hop-by-hop headers named by the request's own `Connection` header, as
 * required by RFC 9110, in addition to the fixed list above. Without this a
 * proxy could forward a header relevant only to the browser-to-proxy hop.
 */
function filterHopByHop(headers) {
  const connectionTokens = typeof headers.connection === 'string'
    ? headers.connection.split(',').map((token) => token.trim().toLowerCase())
    : []
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (value === undefined || HOP_BY_HOP.has(lower) || connectionTokens.includes(lower)) continue
    out[name] = value
  }
  return out
}

/**
 * Canonical `host:port` of the upstream dsh server, in the same form dsh uses
 * for its authority-bound browser-session cookie. IPv6 literals are bracketed.
 *
 * @param target - the upstream `{ host, port }` tuple.
 * @returns the upstream authority.
 */
export function targetAuthority(target) {
  const host = String(target.host)
  return `${host.includes(':') ? `[${host}]` : host}:${String(target.port)}`
}

/**
 * Rewrite the request identity headers so the upstream sees a loopback
 * request, regardless of the public hostname the browser used to reach this
 * proxy.
 *
 * dsh and many dsh plugins treat a request as local when its `Host` (and the
 * matching `Origin`) names loopback. A password-gated request has already
 * been authenticated by this proxy, so forwarding the browser's public
 * `Host`/`Origin` only makes those plugins reject an otherwise trusted
 * request. This is the behavior the Traefik `dsh-loopback` middleware used to
 * implement; doing it here keeps every deployment path consistent, including
 * WebSocket upgrades.
 *
 * `Referer` is normalized for the same reason: it is a browser-origin hint,
 * not user identity. `Sec-Fetch-Site` is deliberately left untouched, so dsh's
 * CSRF fence still rejects genuinely cross-site traffic even after Host and
 * Origin have been translated to loopback.
 *
 * Forwarding headers are rewritten too: a plugin that consults
 * `X-Forwarded-For`/`X-Forwarded-Host` instead of the socket or `Host` must see
 * the same loopback peer, not the public client address added by Traefik or
 * nginx.
 *
 * @param headers - incoming request headers (already hop-by-hop filtered).
 * @param target - the upstream `{ host, port }` tuple.
 * @returns a new header object addressed to the loopback upstream.
 */
export function loopbackHeaders(headers, target) {
  const authority = targetAuthority(target)
  const origin = `http://${authority}`
  const out = { ...headers, host: authority, origin }
  if (typeof out.referer === 'string' && out.referer !== '') {
    try {
      const referer = new URL(out.referer)
      referer.protocol = 'http:'
      referer.host = authority
      out.referer = referer.href
    } catch {
      // A malformed Referer is not worth preserving; make it local as well.
      out.referer = `${origin}/`
    }
  }
  if (out['x-forwarded-for'] !== undefined) out['x-forwarded-for'] = '127.0.0.1'
  if (out['x-real-ip'] !== undefined) out['x-real-ip'] = '127.0.0.1'
  if (out['x-forwarded-host'] !== undefined) out['x-forwarded-host'] = authority
  if (out['x-forwarded-port'] !== undefined) out['x-forwarded-port'] = String(target.port)
  if (out['x-forwarded-proto'] !== undefined) out['x-forwarded-proto'] = 'http'
  if (out.forwarded !== undefined) {
    out.forwarded = `for=127.0.0.1;host="${authority}";proto=http`
  }
  return out
}

/**
 * The browser-facing origin of a request, reconstructed from the headers a
 * reverse proxy forwards. Used to translate absolute upstream redirects back
 * to the public origin after request headers were rewritten to loopback.
 */
export function browserOrigin(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return undefined
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      return new URL(origin).origin
    } catch {
      // Fall through to the forwarded/metadata hints.
    }
  }
  const forwardedProto = req.headers['x-forwarded-proto']
  const proto = typeof forwardedProto === 'string' && forwardedProto !== ''
    ? forwardedProto.split(',', 1)[0].trim()
    : 'http'
  try {
    return new URL(`${proto}://${host}`).origin
  } catch {
    return undefined
  }
}

/**
 * Translate response headers generated against the loopback upstream back to
 * the browser-facing origin. Only absolute `Location` values pointing at the
 * upstream loopback origin are changed; relative redirects stay untouched.
 *
 * Upstream `dsh-auth-*` cookies are not relayed: the proxy redeemed that
 * session server-side, and the cookie is bound to the loopback authority the
 * browser never sees.
 *
 * @param headers - upstream response headers.
 * @param req - the original browser request.
 * @param target - the upstream `{ host, port }` tuple.
 * @returns a new header object safe to send to the browser.
 */
export function rewriteResponseHeaders(headers, req, target) {
  const out = { ...headers }
  const loopback = `http://${targetAuthority(target)}`
  const publicOrigin = browserOrigin(req)
  if (
    publicOrigin !== undefined &&
    typeof out.location === 'string' &&
    /^https?:\/\//i.test(out.location)
  ) {
    try {
      const location = new URL(out.location)
      if (location.origin === loopback) {
        out.location = `${publicOrigin}${location.pathname}${location.search}${location.hash}`
      }
    } catch {
      // Leave malformed/unusual Location values to the upstream.
    }
  }

  const raw = out['set-cookie']
  const cookies = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  const kept = cookies.filter((cookie) => {
    const pair = String(cookie).split(';', 1)[0]?.trim().toLowerCase() ?? ''
    return !pair.startsWith(DSH_COOKIE_PREFIX)
  })
  if (raw !== undefined) {
    if (kept.length === 0) delete out['set-cookie']
    else out['set-cookie'] = Array.isArray(raw) ? kept : kept[0]
  }
  return out
}

/**
 * Whether a request URL names an immutable, content-addressed asset.
 *
 * Vite assets carry their content hash in the filename. dsh's plugin bundle
 * route puts the host-computed revision in the `rev` query parameter. Both can
 * be cached for a year: a change always produces a different URL.
 *
 * @param rawUrl - a request URL or request target.
 * @returns true when the URL is safe to cache immutably.
 */
export function isImmutableAssetUrl(rawUrl) {
  let url
  try {
    url = new URL(rawUrl ?? '/', 'http://dsh-gateway.invalid')
  } catch {
    return false
  }
  if (url.pathname.startsWith('/assets/')) return true
  return url.pathname.startsWith('/plugins/') && /[?&]rev=/.test(url.search)
}

/** Merge one token into a `Vary` header without duplicating it. */
function addVary(headers, token) {
  const current = headers.vary
  const values = typeof current === 'string'
    ? current.split(',').map((value) => value.trim()).filter((value) => value !== '')
    : []
  if (!values.some((value) => value.toLowerCase() === token.toLowerCase())) values.push(token)
  headers.vary = values.join(', ')
}

/**
 * Add cache policy to a proxied response.
 *
 * HTML is authenticated and rendered per request, so it must be revalidated on
 * every navigation and must not enter a shared cache. Hashed assets are public
 * and immutable. API traffic is never cacheable. Upstream dsh currently sends
 * no cache headers for assets or the app shell, which is why a browser had no
 * permission to persist them across reloads.
 *
 * @param req - the original browser request.
 * @param headers - mutable response headers about to be written.
 * @param statusCode - upstream response status; only successful immutable
 *   resources may receive the one-year cache header.
 * @returns the same headers object.
 */
export function applyCachePolicy(req, headers, statusCode = 200) {
  if (isImmutableAssetUrl(req.url)) {
    if (statusCode >= 200 && statusCode < 300) {
      headers['cache-control'] = 'public, max-age=31536000, immutable'
    } else if (statusCode >= 400) {
      headers['cache-control'] = 'no-store'
    }
    return headers
  }

  let pathname = ''
  try {
    pathname = new URL(req.url ?? '/', 'http://dsh-gateway.invalid').pathname
  } catch {
    return headers
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    headers['cache-control'] = 'no-store'
    return headers
  }
  if (String(headers['content-type'] ?? '').includes('text/html')) {
    headers['cache-control'] = 'private, no-cache'
    addVary(headers, 'Cookie')
  }
  return headers
}

/**
 * The cookie prefix dsh uses for its signed browser-session cookies
 * (`dsh-auth-<base64url sha256 of the request authority>`).
 */
export const DSH_COOKIE_PREFIX = 'dsh-auth-'

/** This proxy's own password-gate cookie; never forwarded upstream. */
const COOKIE_NAME = 'dsh_web_session'

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
  const dropped = [DSH_COOKIE_PREFIX]
  // The password-gate cookie is internal to this proxy. Forwarding it upstream
  // would expose the browser's bearer token to every plugin; the dsh session
  // cookie above is the only credential dsh itself needs.
  dropped.push(`${COOKIE_NAME}=`)
  const kept = typeof raw === 'string'
    ? raw.split(';')
      .map((segment) => segment.trim())
      .filter((segment) => segment !== '' && !dropped.some((prefix) => segment.startsWith(prefix)))
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
    const headers = applyCachePolicy(req, rewriteResponseHeaders(upstreamRes.headers, req, options.target), statusCode)
    res.writeHead(statusCode, upstreamRes.statusMessage, headers)
    upstreamRes.pipe(res)
    return
  }

  const chunks = []
  upstreamRes.on('data', (chunk) => chunks.push(chunk))
  upstreamRes.on('end', () => {
    const headers = applyCachePolicy(req, rewriteResponseHeaders(upstreamRes.headers, req, options.target), statusCode)
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
      res.end(`dsh-gateway: upstream response error: ${err.message}`)
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
    let headers = replaceSessionCookie(filterHopByHop(req.headers), options.sessionCookie)
    if (options.loopback !== false) headers = loopbackHeaders(headers, target)
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
  res.end(`dsh-gateway: upstream unavailable: ${message}`)
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
      const headers = applyCachePolicy(req, rewriteResponseHeaders(upstreamRes.headers, req, target), 401)
      delete headers['transfer-encoding']
      headers['content-length'] = String(Buffer.concat(chunks).length)
      res.writeHead(401, upstreamRes.statusMessage, headers)
      res.end(Buffer.concat(chunks))
      return
    }

    relay(req, upstreamRes, res, { ...options, sessionCookie, target })
    return
  }
}

/**
 * Forward a WebSocket upgrade to the dsh web server. The caller has already
 * checked the session token; this only pipes bytes after that gate.
 */
export function proxyUpgrade(req, socket, head, target, options = {}) {
  // Keep Upgrade/Connection: they are what makes this an upgrade rather than an
  // ordinary GET. Replace the browser's dsh session cookie with the one
  // redeemed for the upstream authority, then present the same loopback
  // Host/Origin identity as ordinary HTTP requests.
  let headers = replaceSessionCookie(req.headers, options.sessionCookie)
  delete headers['proxy-authorization']
  delete headers['proxy-authenticate']
  if (options.loopback !== false) headers = loopbackHeaders(headers, target)

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
