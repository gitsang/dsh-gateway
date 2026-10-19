import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AuthStore, SessionStore } from './stores.js'
import { parseCookies, proxyRequest, proxyUpgrade } from './proxy.js'
import { UpstreamAuth } from './upstream-auth.js'
import { readFormBody, renderLoginPage, safeNext } from './pages.js'
import { ICON_SVG, MANIFEST, SW_JS } from './pwa.js'

export const name = 'web-auth'
// `connection` is optional: the auth gate must still boot when a composition
// omits the browser transport, it just cannot redeem a dsh session then.
export const inject = ['webServer']

export const COOKIE_NAME = 'dsh_web_session'
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

function envString(name, fallback) {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

function envInt(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function envBool(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function defaultDataDir() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'profiles', 'web-auth')
}

export const Config = z.object({
  host: z.string().default(envString('DSH_WEB_AUTH_HOST', '127.0.0.1')),
  // The default port is derived from the dsh web port at startup; this env
  // var only overrides it when explicitly set.
  port: z.natural().max(65535).default(envInt('DSH_WEB_AUTH_PORT')),
  ttlMs: z.natural().min(1).default(envInt('DSH_WEB_AUTH_TTL_MS', DEFAULT_TTL_MS)),
  dataDir: z.string().default(envString('DSH_WEB_AUTH_DATA_DIR', defaultDataDir())),
  pwa: z.boolean().default(envBool('DSH_WEB_AUTH_PWA', true))
})

function upstreamTarget(webServer) {
  return {
    host: '127.0.0.1',
    port: webServer.port
  }
}

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address)
}

/**
 * The authority the browser used, as dsh will canonicalize it: lowercased host
 * with the default port stripped, IPv6 bracketed.
 */
function requestAuthority(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return undefined
  try {
    return new URL(`http://${host}`).host
  } catch {
    return undefined
  }
}

class WebAuthProxy extends Service {
  static Config = Config

  constructor(ctx, config) {
    super(ctx, 'webAuth')
    this.config = config
    this.auth = new AuthStore(join(config.dataDir, 'auth.json'))
    this.sessions = new SessionStore(join(config.dataDir, 'session.json'), config.ttlMs)
    this.server = null
    this.proxyPort = null
    this.sockets = new Set()
    this.upstreamAuth = null
  }

  async [Service.init]() {
    await this.auth.init()
    await this.sessions.init()

    const target = upstreamTarget(this.ctx.webServer)
    // dsh mints its browser-session cookie for the authority a request arrives
    // on, and only hands that cookie out through a per-process launch token on
    // `GET /`. The proxy is the browser's only origin, so it redeems the token
    // itself for each authority it serves and forwards the resulting cookie.
    this.upstreamAuth = new UpstreamAuth(
      target,
      () => this.tokenizedUrl.bind(this),
      this.ctx.logger
    )
    // The auth proxy listens next to dsh web by default (web port + 1).
    // DSH_WEB_AUTH_PORT can still override this.
    this.config = { ...this.config, port: this.config.port ?? Number(target.port) + 1 }
    const listenPort = this.config.port
    this.server = createServer((req, res) => {
      this.handle(req, res, target).catch((err) => {
        this.ctx.logger.error(err)
        if (res.headersSent) {
          res.destroy()
          return
        }
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('dsh-web-auth: internal error')
      })
    })

    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })

    this.server.on('upgrade', (req, socket, head) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      this.handleUpgrade(req, socket, head, target).catch((err) => {
        this.ctx.logger.error(err)
        socket.destroy()
      })
    })

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.off('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        this.server.off('error', onError)
        this.server.on('error', (err) => this.ctx.logger.error(err))
        const address = this.server.address()
        this.proxyPort = typeof address === 'object' && address !== null ? address.port : listenPort
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(listenPort, this.config.host)
    })

    this.ctx.effect(() => async () => this.close(), 'web-auth.proxy')
    this.printUrl(target)
  }

  /**
   * A tokenized application URL for `authority`, from dsh's Connection service.
   *
   * dsh builds this URL from its own loopback address; we only need the token it
   * embeds, so the authority is swapped for the one the browser is using. When
   * Connection is absent the gate still works for the password layer, but dsh
   * itself will answer 401 — exactly as it did before this custodian existed.
   */
  tokenizedUrl(authority) {
    const connection = this.ctx.get('connection')
    if (connection === undefined) return undefined
    return connection.authenticatedUrl(`http://${authority}/`)
  }

  getSession(req) {
    const cookies = parseCookies(req.headers.cookie)
    const token = cookies[COOKIE_NAME]
    if (token === undefined || token === '') return undefined
    return this.sessions.get(token)
  }

  async handle(req, res, target) {
    const url = new URL(req.url ?? '/', 'http://dsh-web-auth.invalid')
    const pathname = url.pathname

    if (pathname === '/login') {
      if (req.method === 'GET') {
        await this.serveLoginPage(req, res)
        return
      }
      if (req.method === 'POST') {
        await this.handleLoginPost(req, res)
        return
      }
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
      return
    }

    if (pathname === '/logout') {
      await this.handleLogout(req, res)
      return
    }

    if (this.config.pwa) {
      if (pathname === '/manifest.webmanifest') {
        res.writeHead(200, {
          'content-type': 'application/manifest+json; charset=utf-8',
          'cache-control': 'no-cache'
        })
        res.end(JSON.stringify(MANIFEST))
        return
      }

      if (pathname === '/sw.js') {
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-cache'
        })
        res.end(SW_JS)
        return
      }

      if (pathname === '/favicon.svg') {
        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'no-cache'
        })
        res.end(ICON_SVG)
        return
      }
    }

    // If auth.json was deleted (forgot-password reset), never fall through on
    // a leftover session cookie: force the setup flow again.
    if (!this.auth.hasPassword()) {
      this.deny(req, res)
      return
    }

    const session = this.getSession(req)
    if (session !== undefined) {
      this.sessions.touch(session.token)
      const authority = requestAuthority(req)
      const cookie = authority === undefined ? undefined : await this.upstreamAuth.cookieFor(authority)
      await proxyRequest(req, res, target, {
        pwa: this.config.pwa,
        sessionCookie: cookie,
        // dsh rejected the cookie we cached (expired, or it restarted with a
        // new launch token). Redeem a fresh one and let the proxy retry.
        reauthorize: authority === undefined
          ? undefined
          : () => this.reauthorize(authority)
      })
      return
    }

    this.deny(req, res)
  }

  /**
   * Replace a rejected cookie: drop the stale entry and redeem a fresh one for
   * the same authority. `refresh` coalesces concurrent callers, so a page load
   * whose requests all trip the stale cookie performs one token exchange.
   */
  async reauthorize(authority) {
    this.upstreamAuth.forget(authority)
    return this.upstreamAuth.refresh(authority)
  }

  deny(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh-web-auth.invalid')
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    const next = encodeURIComponent(req.url ?? '/')
    res.writeHead(302, { location: `/login?next=${next}` })
    res.end()
  }

  async serveLoginPage(req, res, options = {}) {
    const setup = !this.auth.hasPassword()
    const next = safeNext(new URL(req.url ?? '/', 'http://dsh-web-auth.invalid').searchParams.get('next') ?? '/')
    const html = renderLoginPage({
      setup,
      next,
      error: options.error,
      pwa: this.config.pwa
    })
    res.writeHead(options.status ?? 200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(html)
  }

  async handleLoginPost(req, res) {
    let body
    try {
      body = await readFormBody(req)
    } catch {
      res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh-web-auth: request body too large')
      return
    }

    const params = new URLSearchParams(body)
    const password = params.get('password') ?? ''
    const confirm = params.get('confirm')
    const next = safeNext(params.get('next') ?? '/')
    const setup = !this.auth.hasPassword()

    if (setup) {
      if (password.length === 0) {
        await this.serveLoginPage(req, res, { status: 400, error: '请输入密码。' })
        return
      }
      if (password !== confirm) {
        await this.serveLoginPage(req, res, { status: 400, error: '两次输入的密码不一致。' })
        return
      }
      await this.auth.setPassword(password)
    } else {
      const valid = await this.auth.verify(password)
      if (!valid) {
        await this.serveLoginPage(req, res, { status: 401, error: '密码错误。' })
        return
      }
    }

    const token = await this.sessions.create()
    res.writeHead(302, {
      location: next,
      'set-cookie': `${COOKIE_NAME}=${token}`
    })
    res.end()
  }

  async handleLogout(req, res) {
    const cookies = parseCookies(req.headers.cookie)
    const token = cookies[COOKIE_NAME]
    if (token !== undefined && token !== '') await this.sessions.delete(token)

    res.writeHead(302, {
      location: '/login',
      'set-cookie': `${COOKIE_NAME}=`
    })
    res.end()
  }

  async handleUpgrade(req, socket, head, target) {
    const session = this.getSession(req)
    if (session === undefined) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 12\r\n\r\nunauthorized')
      socket.destroy()
      return
    }
    this.sessions.touch(session.token)
    const authority = requestAuthority(req)
    const cookie = authority === undefined ? undefined : await this.upstreamAuth.cookieFor(authority)
    proxyUpgrade(req, socket, head, target, { sessionCookie: cookie })
  }

  printUrl(target) {
    const host = this.config.host === '0.0.0.0' ? '127.0.0.1' : this.config.host
    const lan = this.config.host === '0.0.0.0' ? lanAddresses()[0] : undefined
    const lanText = lan === undefined ? '' : ` (LAN: http://${lan}:${String(this.proxyPort)})`
    console.log(`dsh web-auth: http://${host}:${String(this.proxyPort)} -> http://${target.host}:${String(target.port)}${lanText}`)
  }

  async close() {
    await this.sessions.close()
    if (this.server !== null) {
      this.server.closeAllConnections?.()
      for (const socket of this.sockets) socket.destroy()
      this.sockets.clear()
      await new Promise((resolve) => this.server.close(() => resolve()))
    }
  }
}

export { WebAuthProxy }
export default WebAuthProxy
