import { request as httpRequest } from 'node:http'

/**
 * Server-side custodian of dsh's browser-session cookie.
 *
 * dsh's `client-connection` guards every `/api` RPC and every WebSocket stream
 * with a signed cookie whose name and payload are bound to the request
 * authority (host + port). A browser only ever receives that cookie by
 * redeeming a per-process launch token on `GET /`, and dsh prints/opens that
 * tokenized URL on its *own* port — which sits behind this proxy. Opening it
 * therefore mints a cookie bound to `host:3080`, and the very next request the
 * user makes to `host:3081` carries no cookie dsh will accept: `401 dsh web
 * authentication required`, even though the password gate already passed.
 *
 * The fix is to make the proxy a client of dsh in its own right: for each
 * authority a browser reaches us on, ask dsh for a fresh tokenized URL, redeem
 * it exactly as a browser would, and keep the resulting cookie. Every proxied
 * request and WebSocket upgrade then carries a cookie dsh considers valid for
 * the authority we forward — so the password gate is the only gate the user
 * interacts with, and the launch token never has to round-trip through the
 * address bar.
 */

/** How long a cached cookie is reused before a proactive re-exchange. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000

/**
 * Send one `GET /?token=…` to dsh and return the cookie it sets.
 *
 * The reply is dsh's 303 to `./`, whose `set-cookie` carries the signed
 * browser-session cookie. We keep only the `name=value` pair: the browser holds
 * this cookie through us, so its own attributes (`Max-Age`, `HttpOnly`, …) are
 * meaningless here.
 */
function exchangeToken(target, tokenizedUrl) {
  const url = new URL(tokenizedUrl)
  return new Promise((resolve, reject) => {
    const upstream = httpRequest({
      hostname: target.host,
      port: target.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      // dsh binds the cookie to the authority it observes, so the exchange must
      // present exactly the authority the browser used to reach this proxy.
      headers: {
        host: url.host,
        accept: 'text/html',
        // Keep dsh's redirect from being followed implicitly; we only want the
        // Set-Cookie header off this one reply.
        connection: 'close'
      }
    }, (res) => {
      res.resume()
      const raw = res.headers['set-cookie']
      const cookies = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
      for (const cookie of cookies) {
        const pair = cookie.split(';', 1)[0]?.trim()
        if (pair === undefined || !pair.startsWith('dsh-auth-')) continue
        resolve(pair)
        return
      }
      reject(new Error(`dsh web did not set a session cookie (HTTP ${res.statusCode ?? 'unknown'}); is it behind a different authority than it trusts?`))
    })
    upstream.on('error', reject)
    upstream.end()
  })
}

/** One cached cookie and when it was obtained. */
class CachedCookie {
  constructor(pair, obtainedAt) {
    this.pair = pair
    this.obtainedAt = obtainedAt
  }

  get stale() {
    return Date.now() - this.obtainedAt > REFRESH_MARGIN_MS
  }
}

export class UpstreamAuth {
  /**
   * @param target Upstream `{ host, port }`.
   * @param resolveTokenizedUrl Returns a tokenized URL for `http://<authority>/`,
   *   or undefined while the Connection service is not available yet.
   * @param logger Optional logger for non-fatal exchange failures.
   */
  constructor(target, resolveTokenizedUrl, logger) {
    this.target = target
    this.resolveTokenizedUrl = resolveTokenizedUrl
    this.logger = logger
    this.cache = new Map()
    this.pending = new Map()
    this.lastError = null
  }

  /**
   * Return the cookie to forward for `authority`, exchanging a launch token when
   * none is cached. Never throws: an unreachable or refusing dsh means we proxy
   * without a cookie, and the browser sees dsh's own 401 — the same behavior as
   * before this custodian existed, never a proxy-local failure.
   */
  async cookieFor(authority) {
    const cached = this.cache.get(authority)
    if (cached !== undefined && !cached.stale) return cached.pair
    return this.refresh(authority)
  }

  /** Force a new exchange for `authority`, coalescing concurrent callers. */
  async refresh(authority) {
    const inFlight = this.pending.get(authority)
    if (inFlight !== undefined) return inFlight
    const started = this.exchange(authority).finally(() => this.pending.delete(authority))
    this.pending.set(authority, started)
    return started
  }

  async exchange(authority) {
    const source = this.resolveTokenizedUrl?.()
    if (source === undefined) return undefined
    try {
      const pair = await exchangeToken(this.target, source(authority))
      this.cache.set(authority, new CachedCookie(pair, Date.now()))
      if (this.lastError !== null) {
        this.logger?.info('web-auth: recovered the dsh browser session for %s', authority)
        this.lastError = null
      }
      return pair
    } catch (error) {
      // Log the transition only: a request storm must not flood the log.
      if (this.lastError !== error?.message) {
        this.lastError = error?.message
        this.logger?.warn('web-auth: cannot obtain a dsh browser session for %s: %s', authority, error?.message ?? error)
      }
      return undefined
    }
  }

  /** Drop one authority's cookie — used after dsh answers 401 to a fresh one. */
  forget(authority) {
    this.cache.delete(authority)
  }
}
