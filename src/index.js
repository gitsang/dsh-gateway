import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { networkInterfaces, homedir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AuthStore, SessionStore } from './stores.js'
import { parseCookies, proxyRequest, proxyUpgrade, targetAuthority } from './proxy.js'
import { UpstreamAuth } from './upstream-auth.js'
import { readFormBody, renderLoginPage, safeNext } from './pages.js'
import { ICON_SVG, MANIFEST, SW_DISABLED_JS, SW_JS } from './pwa.js'
import { GatewaySettingsStore } from './settings-store.js'

export const name = 'gateway'
// `connection` is optional: the gateway must still boot when a composition
// omits the browser transport, it just cannot redeem a dsh session then.
export const inject = ['webServer']

export const COOKIE_NAME = 'dsh_gateway_session'
export const GATEWAY_API_PREFIX = '/__dsh_gateway'
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version

const HOST_ENV = ['DSH_GATEWAY_HOST']
const PORT_ENV = ['DSH_GATEWAY_PORT']
const TTL_ENV = ['DSH_GATEWAY_TTL_MS']
const DATA_DIR_ENV = ['DSH_GATEWAY_DATA_DIR']
const PWA_ENV = ['DSH_GATEWAY_PWA']
const HOST_MODE_ENV = ['DSH_GATEWAY_HOST_MODE']

/** Read the first non-empty environment variable from a compatibility list. */
function envValue(names) {
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

function envString(names, fallback) {
  return envValue(names) ?? fallback
}

function envInt(names, fallback) {
  const raw = envValue(names)
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function parseBool(raw) {
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function envBool(names, fallback) {
  const raw = envValue(names)
  return raw === undefined ? fallback : parseBool(raw)
}

/** `undefined` means the setting is not environment-locked. */
function envBoolOverride(names) {
  const raw = envValue(names)
  return raw === undefined ? undefined : parseBool(raw)
}

function defaultDataDir() {
  const explicit = envValue(DATA_DIR_ENV)
  if (explicit !== undefined) return explicit
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'profiles', 'gateway')
}

export const Config = z.object({
  host: z.string().default(envString(HOST_ENV, '127.0.0.1')),
  // The default port is derived from the dsh web port at startup; this env
  // var only overrides it when explicitly set.
  port: z.natural().max(65535).default(envInt(PORT_ENV)),
  ttlMs: z.natural().min(1).default(envInt(TTL_ENV, DEFAULT_TTL_MS)),
  dataDir: z.string().default(defaultDataDir()),
  pwa: z.boolean().default(envBool(PWA_ENV, true)),
  // Declare the proxied page as a host-owning page so dsh uses Host settings
  // (Models page, "open configuration file") instead of its read-only memory
  // fallback. On by default because a remote dsh web UI is unusable without it;
  // it does hand every signed-in user the same configuration-write surface the
  // Desktop shell has, so the Settings > Gateway page can turn it off.
  hostMode: z.boolean().default(envBool(HOST_MODE_ENV, true))
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

class DshGateway extends Service {
  static Config = Config

  constructor(ctx, config) {
    super(ctx, 'gateway')
    this.config = config
    this.auth = new AuthStore(join(config.dataDir, 'auth.json'))
    this.sessions = new SessionStore(join(config.dataDir, 'session.json'), config.ttlMs)
    this.settings = new GatewaySettingsStore(join(config.dataDir, 'settings.json'))
    this.envOverrides = {
      pwa: envBoolOverride(PWA_ENV),
      hostMode: envBoolOverride(HOST_MODE_ENV)
    }
    this.runtimePwa = config.pwa
    this.bootHostMode = config.hostMode
    this.configuredHostMode = config.hostMode
    this.startedAt = Date.now()
    this.target = null
    this.server = null
    this.proxyPort = null
    this.sockets = new Set()
    this.upstreamAuth = null
  }

  async [Service.init]() {
    await Promise.all([this.auth.init(), this.sessions.init(), this.settings.init()])

    const saved = this.settings.snapshot()
    this.runtimePwa = this.envOverrides.pwa ?? saved.pwa ?? this.config.pwa
    this.bootHostMode = this.envOverrides.hostMode ?? saved.hostMode ?? this.config.hostMode
    this.configuredHostMode = this.bootHostMode
    this.config = { ...this.config, pwa: this.runtimePwa, hostMode: this.bootHostMode }

    const target = upstreamTarget(this.ctx.webServer)
    this.target = target
    // dsh mints its browser-session cookie for the authority a request arrives
    // on, and only hands that cookie out through a per-process launch token on
    // `GET /`. Proxied requests always present the loopback upstream authority,
    // so that is the one authority for which we redeem and cache a cookie.
    this.upstreamAuth = new UpstreamAuth(
      target,
      (authority) => this.tokenizedUrl(authority),
      this.ctx.logger
    )
    // The gateway listens next to dsh web by default (web port + 1).
    // DSH_GATEWAY_PORT can still override this.
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
        res.end('dsh-gateway: internal error')
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

    this.ctx.effect(() => async () => this.close(), 'gateway.proxy')

    // Primary Host-mode carrier: declare the transport flag inside dsh's own
    // index.html, so it survives proxies that cache or rewrite our responses.
    // The switch is evaluated at boot; changing it needs a restart.
    if (this.bootHostMode) {
      this.ctx.inject(['webServer'], (webCtx) => {
        webCtx.on('webserver/index-inject', (table) => {
          table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
        })
      })
    }

    this.printUrl(target)
  }

  /**
   * A tokenized application URL for the loopback `authority`, from dsh's
   * Connection service.
   *
   * dsh builds this URL from its own loopback address, which is also the
   * authority every proxied request presents upstream. When Connection is
   * absent the gate still works for the password layer, but dsh itself will
   * answer 401 — exactly as it did before this custodian existed.
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
    const url = new URL(req.url ?? '/', 'http://dsh-gateway.invalid')
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

    // The PWA worker must remain reachable when PWA support is switched off so
    // an already-installed worker can be updated into its cleanup version.
    if (pathname === '/sw.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache'
      })
      res.end(this.runtimePwa ? SW_JS : SW_DISABLED_JS)
      return
    }

    if (pathname === '/manifest.webmanifest' || pathname === '/favicon.svg') {
      if (!this.runtimePwa) {
        res.writeHead(404, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      if (pathname === '/manifest.webmanifest') {
        res.writeHead(200, {
          'content-type': 'application/manifest+json; charset=utf-8',
          'cache-control': 'no-cache'
        })
        res.end(JSON.stringify(MANIFEST))
        return
      }
      res.writeHead(200, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'no-cache'
      })
      res.end(ICON_SVG)
      return
    }

    // If auth.json was deleted (forgot-password reset), never fall through on
    // a leftover session cookie: force the setup flow again.
    if (!this.auth.hasPassword()) {
      this.deny(req, res)
      return
    }

    const session = this.getSession(req)
    if (pathname === GATEWAY_API_PREFIX || pathname.startsWith(`${GATEWAY_API_PREFIX}/`)) {
      if (session === undefined) {
        this.denyApi(res)
        return
      }
      this.sessions.touch(session.token)
      await this.handleGatewayApi(req, res, pathname, session)
      return
    }

    if (session !== undefined) {
      this.sessions.touch(session.token)
      // The browser-facing Host is rewritten to this authority by proxy.js, so
      // the dsh session cookie must be minted for the same loopback authority.
      const authority = targetAuthority(target)
      const cookie = await this.upstreamAuth.cookieFor(authority)
      await proxyRequest(req, res, target, {
        pwa: this.runtimePwa,
        hostMode: this.bootHostMode,
        sessionCookie: cookie,
        // dsh rejected the cookie we cached (expired, or it restarted with a
        // new launch token). Redeem a fresh one and let the proxy retry.
        reauthorize: () => this.reauthorize(authority)
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
    const url = new URL(req.url ?? '/', 'http://dsh-gateway.invalid')
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      this.denyApi(res)
      return
    }

    const next = encodeURIComponent(req.url ?? '/')
    res.writeHead(302, { location: `/login?next=${next}` })
    res.end()
  }

  denyApi(res) {
    res.writeHead(401, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(JSON.stringify({ error: 'unauthorized' }))
  }

  settingSource(key) {
    if (this.envOverrides[key] !== undefined) return 'env'
    if (this.settings.has(key)) return 'settings'
    return 'default'
  }

  gatewayState() {
    return {
      name: 'dsh-gateway',
      version: PACKAGE_VERSION,
      listen: { host: this.config.host, port: this.proxyPort },
      upstream: { host: this.target.host, port: this.target.port },
      sessions: this.sessions.size(),
      uptimeMs: Date.now() - this.startedAt,
      hasPassword: this.auth.hasPassword(),
      dataDir: this.config.dataDir,
      pwa: {
        value: this.runtimePwa,
        source: this.settingSource('pwa'),
        locked: this.envOverrides.pwa !== undefined
      },
      hostMode: {
        value: this.bootHostMode,
        configured: this.configuredHostMode,
        source: this.settingSource('hostMode'),
        locked: this.envOverrides.hostMode !== undefined,
        restartRequired: this.configuredHostMode !== this.bootHostMode
      }
    }
  }

  sendJson(res, status, body) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(JSON.stringify(body))
  }

  async readJsonBody(req) {
    const raw = await readFormBody(req)
    if (raw === '') return {}
    return JSON.parse(raw)
  }

  /**
   * The settings page mutates host state, so require both a same-origin fetch
   * and a custom header. A cross-site form can send neither; requiring the
   * header also keeps a cross-origin `fetch` in the CORS preflight path.
   */
  isTrustedApiRequest(req) {
    if (req.headers['x-dsh-gateway'] !== '1') return false
    const site = req.headers['sec-fetch-site']
    return site === undefined || site === 'same-origin' || site === 'none'
  }

  async handleGatewayApi(req, res, pathname, session) {
    if (pathname === `${GATEWAY_API_PREFIX}/state` && req.method === 'GET') {
      this.sendJson(res, 200, this.gatewayState())
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (!this.isTrustedApiRequest(req)) {
      this.sendJson(res, 403, { error: 'forbidden' })
      return
    }

    let body
    try {
      body = await this.readJsonBody(req)
    } catch {
      this.sendJson(res, 400, { error: 'invalid JSON body' })
      return
    }

    if (pathname === `${GATEWAY_API_PREFIX}/settings`) {
      await this.updateGatewaySettings(res, body)
      return
    }

    if (pathname === `${GATEWAY_API_PREFIX}/password`) {
      await this.changePassword(res, body, session)
      return
    }

    if (pathname === `${GATEWAY_API_PREFIX}/logout-all`) {
      const revoked = await this.sessions.deleteAll()
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': `${COOKIE_NAME}=`
      })
      res.end(JSON.stringify({ ok: true, revoked }))
      return
    }

    this.sendJson(res, 404, { error: 'not found' })
  }

  async updateGatewaySettings(res, body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      this.sendJson(res, 400, { error: 'settings must be an object' })
      return
    }
    const patch = {}
    for (const key of ['pwa', 'hostMode']) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue
      if (typeof body[key] !== 'boolean') {
        this.sendJson(res, 400, { error: `${key} must be a boolean` })
        return
      }
      if (this.envOverrides[key] !== undefined) {
        this.sendJson(res, 409, { error: `${key} is managed by an environment variable` })
        return
      }
      patch[key] = body[key]
    }
    if (Object.keys(patch).length === 0) {
      this.sendJson(res, 400, { error: 'no supported settings supplied' })
      return
    }
    if (patch.pwa !== undefined) this.runtimePwa = patch.pwa
    if (patch.hostMode !== undefined) this.configuredHostMode = patch.hostMode
    await this.settings.update(patch)
    this.sendJson(res, 200, this.gatewayState())
  }

  async changePassword(res, body, session) {
    const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : ''
    const confirm = typeof body?.confirm === 'string' ? body.confirm : ''
    if (newPassword === '') {
      this.sendJson(res, 400, { error: '新密码不能为空。' })
      return
    }
    if (newPassword !== confirm) {
      this.sendJson(res, 400, { error: '两次输入的新密码不一致。' })
      return
    }
    if (!(await this.auth.verify(currentPassword))) {
      this.sendJson(res, 401, { error: '当前密码错误。' })
      return
    }
    await this.auth.setPassword(newPassword)
    const revoked = await this.sessions.deleteAll(session.token)
    this.sendJson(res, 200, { ok: true, revoked })
  }

  async serveLoginPage(req, res, options = {}) {
    const setup = !this.auth.hasPassword()
    const next = safeNext(new URL(req.url ?? '/', 'http://dsh-gateway.invalid').searchParams.get('next') ?? '/')
    const html = renderLoginPage({
      setup,
      next,
      error: options.error,
      pwa: this.runtimePwa
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
      res.end('dsh-gateway: request body too large')
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
    const authority = targetAuthority(target)
    const cookie = await this.upstreamAuth.cookieFor(authority)
    proxyUpgrade(req, socket, head, target, { sessionCookie: cookie })
  }

  printUrl(target) {
    const host = this.config.host === '0.0.0.0' ? '127.0.0.1' : this.config.host
    const lan = this.config.host === '0.0.0.0' ? lanAddresses()[0] : undefined
    const lanText = lan === undefined ? '' : ` (LAN: http://${lan}:${String(this.proxyPort)})`
    console.log(`dsh-gateway: http://${host}:${String(this.proxyPort)} -> http://${target.host}:${String(target.port)}${lanText}`)
    if (this.bootHostMode) {
      console.log('dsh-gateway: host mode is ON — every signed-in user can edit this profile\'s settings and plugins')
    }
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

export { DshGateway }
export default DshGateway
