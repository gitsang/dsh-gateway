import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { renderUnauthorizedPage } from './pages.js'
import { injectHostModeTag, injectPwaTags } from './pwa.js'

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
 * matching `Origin`) names loopback. A request that reached this proxy has
 * already been routed deliberately by the operator, so forwarding the
 * browser's public `Host`/`Origin` only makes those plugins reject an
 * otherwise valid request. This is the behavior the Traefik `dsh-loopback`
 * middleware used to implement; doing it here keeps every deployment path
 * consistent, including WebSocket upgrades.
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
 * The cookie the gateway used to mint for its own password gate. Browsers that
 * signed in before that gate was removed still hold one; it must not be
 * forwarded to dsh or any plugin, because it is a dead bearer token.
 */
const LEGACY_SESSION_COOKIE = 'dsh_gateway_session'

/**
 * Drop a leftover password-gate cookie from the `Cookie` header. Everything
 * else — including the `dsh-auth-*` cookie dsh minted — is forwarded unchanged:
 * the gateway no longer replaces the browser's credential with its own.
 */
function stripLegacySessionCookie(headers) {
  const raw = headers.cookie
  if (typeof raw !== 'string' || raw === '') return headers
  const kept = raw.split(';')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && !segment.startsWith(`${LEGACY_SESSION_COOKIE}=`))
  const out = { ...headers }
  if (kept.length === 0) delete out.cookie
  else out.cookie = kept.join('; ')
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

/** The cookie prefix dsh uses for its signed browser-session cookies. */
export const DSH_COOKIE_PREFIX = 'dsh-auth-'

/**
 * The exact cookie name dsh mints for `authority`: the fixed prefix plus the
 * base64url SHA-256 of the authority the cookie is bound to.
 *
 * The gateway needs it for one thing only — expiring that cookie on sign-out,
 * because an `HttpOnly` cookie cannot be cleared from page JavaScript.
 *
 * @param authority - canonical `host:port` the request is forwarded under.
 * @returns dsh's cookie name for that authority.
 */
export function dshCookieName(authority) {
  return DSH_COOKIE_PREFIX + createHash('sha256').update(authority).digest('base64url')
}

/**
 * Add `Secure` to a dsh session cookie when the browser-facing hop is HTTPS.
 *
 * dsh marks its cookie `Secure` only when its own listener terminates TLS. A
 * gateway behind an HTTPS reverse proxy speaks plain HTTP upstream, so without
 * this the browser would be handed a non-`Secure` bearer cookie for an HTTPS
 * origin. The cookie keeps every attribute dsh chose; only that one is added.
 */
function secureSessionCookie(cookie, secure) {
  if (!secure) return cookie
  if (!String(cookie).trimStart().startsWith(DSH_COOKIE_PREFIX)) return cookie
  if (/;\s*secure\b/i.test(cookie)) return cookie
  return `${cookie}; Secure`
}

/** Whether the browser-facing origin uses HTTPS. */
function isSecureBrowserOrigin(req) {
  const origin = browserOrigin(req)
  return origin !== undefined && origin.startsWith('https://')
}

/**
 * Translate response headers generated against the loopback upstream back to
 * the browser-facing origin. Only absolute `Location` values pointing at the
 * upstream loopback origin are changed; relative redirects stay untouched.
 *
 * Cookies are relayed as dsh sent them: the browser holds dsh's own
 * authority-bound session cookie rather than a gateway session. The only edit
 * is adding `Secure` when the public hop is HTTPS.
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
  if (raw !== undefined) {
    const secure = isSecureBrowserOrigin(req)
    const cookies = (Array.isArray(raw) ? raw : [raw]).map((cookie) => secureSessionCookie(cookie, secure))
    out['set-cookie'] = Array.isArray(raw) ? cookies : cookies[0]
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
 * Whether a response is dsh's browser-session rejection rather than some other
 * 401. dsh answers a missing/expired cookie with a fixed plain-text body.
 */
export function isDshAuthRejection(upstreamRes, body) {
  return upstreamRes.statusCode === 401 &&
    String(upstreamRes.headers['content-type'] ?? '').includes('text/plain') &&
    body.includes('dsh web authentication required')
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

/**
 * Ask dsh whether a browser cookie authenticates a browser session.
 *
 * The gateway owns no credential of its own, and dsh exposes no "check this
 * cookie" endpoint. The one place dsh verifies a browser cookie and answers
 * something observable is the index route: it serves `index.html` to a valid
 * session and `401` to anything else. A loopback `HEAD /` carrying the
 * browser's cookie therefore asks dsh the exact question, under the authority
 * the gateway forwards on, without transferring a page body. This is how the
 * gateway's own settings API decides whether its caller is signed in.
 *
 * Never throws: an unreachable or refusing dsh means "not authenticated".
 *
 * @param target - the upstream `{ host, port }` tuple.
 * @param cookieHeader - the browser's raw `Cookie` header, or undefined.
 * @returns true only when dsh accepts that cookie for the loopback authority.
 */
export function probeBrowserSession(target, cookieHeader) {
  return new Promise((resolve) => {
    const headers = loopbackHeaders({ accept: 'text/html' }, target)
    if (typeof cookieHeader === 'string' && cookieHeader !== '') headers.cookie = cookieHeader
    const probe = httpRequest({
      hostname: target.host,
      port: target.port,
      path: '/',
      method: 'HEAD',
      headers
    }, (probeRes) => {
      probeRes.resume()
      resolve(probeRes.statusCode === 200)
    })
    probe.on('error', () => resolve(false))
    probe.end()
  })
}

/** Issue one request to dsh; resolves with its response or rejects. */
function send(target, req, options) {
  const headers = loopbackHeaders(stripLegacySessionCookie(filterHopByHop(req.headers)), target)
  // dsh gzips HTML documents only for real browser navigations (Accept:
  // text/html + Sec-Fetch-Dest: document). A compressed body cannot be
  // rewritten, so ask for identity on exactly those requests; stylesheets,
  // scripts and API payloads keep their compression.
  const rewritesHtml = options.pwa !== false || options.hostMode === true
  if (rewritesHtml && isDocumentNavigation(req)) {
    delete headers['accept-encoding']
  }
  return new Promise((resolve, reject) => {
    const upstream = httpRequest({
      hostname: target.host,
      port: target.port,
      path: req.url,
      method: req.method,
      headers
    }, resolve)
    upstream.on('error', reject)
    req.pipe(upstream)
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

/** The largest dsh rejection body the gateway will hold in memory. */
const AUTH_REJECTION_LIMIT_BYTES = 8192

/** Read at most `limit` bytes of a response; only small replies use this. */
function readSmallBody(upstreamRes, limit = AUTH_REJECTION_LIMIT_BYTES) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    upstreamRes.on('data', (chunk) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    const done = () => resolve(Buffer.concat(chunks))
    upstreamRes.once('end', done)
    upstreamRes.once('error', done)
  })
}

/** Relay an already-buffered upstream response. */
function relayBuffered(req, upstreamRes, res, options, body) {
  const statusCode = upstreamRes.statusCode ?? 502
  const headers = applyCachePolicy(req, rewriteResponseHeaders(upstreamRes.headers, req, options.target), statusCode)
  delete headers['transfer-encoding']
  headers['content-length'] = String(body.length)
  res.writeHead(statusCode, upstreamRes.statusMessage, headers)
  res.end(body)
}

/**
 * Forward one HTTP request to the dsh web server and pipe the response back.
 *
 * Authentication is dsh's: the browser's `dsh-auth-*` cookie is forwarded
 * unchanged and dsh decides. The gateway only translates identity (so dsh and
 * its plugins treat the request as local), rewrites HTML for the PWA/Host-mode
 * features, and turns dsh's plain-text 401 into an explanatory page for a
 * top-level navigation.
 *
 * When `options.pwa` is true (the default) and the upstream response is
 * uncompressed HTML, the PWA tags are injected into the head before the
 * response is sent back. Everything else is streamed through untouched.
 *
 * @param req - the incoming browser request.
 * @param res - the response to write.
 * @param target - the upstream `{ host, port }` tuple.
 * @param options - `{ pwa, hostMode, loopback }` feature switches.
 */
export async function proxyRequest(req, res, target, options = {}) {
  let upstreamRes
  try {
    upstreamRes = await send(target, req, options)
  } catch (error) {
    fail(res, error?.message ?? error)
    return
  }

  // dsh answers an unauthenticated navigation with a plain-text 401. Someone
  // opening this gateway without the tokenized URL deserves an explanation
  // instead of a bare line of text.
  if (req.method === 'GET' && isDocumentNavigation(req) && upstreamRes.statusCode === 401) {
    const body = await readSmallBody(upstreamRes)
    if (isDshAuthRejection(upstreamRes, body)) {
      const html = renderUnauthorizedPage({ pwa: options.pwa !== false })
      res.writeHead(401, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        vary: 'Cookie',
        'content-length': String(Buffer.byteLength(html))
      })
      res.end(html)
      return
    }
    relayBuffered(req, upstreamRes, res, { ...options, target }, body)
    return
  }

  relay(req, upstreamRes, res, { ...options, target })
}

/**
 * Forward a WebSocket upgrade to the dsh web server. dsh authenticates the
 * upgrade from the forwarded cookie and rejects it on its own when the
 * credential is missing or expired; this only pipes bytes after that decision.
 */
export function proxyUpgrade(req, socket, head, target, options = {}) {
  // Keep Upgrade/Connection: they are what makes this an upgrade rather than an
  // ordinary GET. Present the same loopback Host/Origin identity as ordinary
  // HTTP requests and forward the browser's dsh cookie unchanged.
  let headers = { ...req.headers }
  delete headers['proxy-authorization']
  delete headers['proxy-authenticate']
  headers = stripLegacySessionCookie(headers)
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

  upstream.on('response', (upstreamRes) => {
    // dsh refused the upgrade (401/403/404). Relay its reply so the browser
    // sees the real reason instead of a dropped socket.
    const statusLine = `HTTP/${upstreamRes.httpVersion} ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`
    let headText = statusLine
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (value === undefined) continue
      headText += `${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`
    }
    headText += '\r\n'
    socket.write(headText)
    upstreamRes.pipe(socket)
  })

  upstream.on('error', () => {
    socket.destroy()
  })

  upstream.end()
}
