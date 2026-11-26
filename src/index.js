import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { networkInterfaces, homedir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshCookieName, probeBrowserSession, proxyRequest, proxyUpgrade, targetAuthority } from './proxy.js'
import { readRequestBody } from './pages.js'
import { ICON_SVG, MANIFEST, SW_DISABLED_JS, SW_JS } from './pwa.js'
import { GatewaySettingsStore } from './settings-store.js'
import { LaunchTokenStore } from './token-store.js'

export const name = 'gateway'
// `connection` is optional: the gateway still proxies when a composition omits
// the browser transport, it just cannot print a tokenized sign-in URL then.
export const inject = ['webServer']

export const GATEWAY_API_PREFIX = '/__dsh_gateway'
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version

const HOST_ENV = ['DSH_GATEWAY_HOST']
const PORT_ENV = ['DSH_GATEWAY_PORT']
const DATA_DIR_ENV = ['DSH_GATEWAY_DATA_DIR']
const PWA_ENV = ['DSH_GATEWAY_PWA']
const HOST_MODE_ENV = ['DSH_GATEWAY_HOST_MODE']
const TOKEN_ENV = ['DSH_GATEWAY_TOKEN']

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

/**
 * The gateway's data directory: `$DSH_HOME/gateway` unless overridden.
 *
 * This is plugin state, not a dsh profile. `profiles/` is reserved for
 * bootable profiles — anything placed there can be booted (`dsh gateway`),
 * and dsh writes profile scaffolding (cordis.yml, package.json) into it. The
 * gateway's own files therefore live beside `profiles/`, like dsh's other
 * home-level state (`bridge/`, `daemon/`, `.credentials.yaml`).
 */
function defaultDataDir() {
  const explicit = envValue(DATA_DIR_ENV)
  if (explicit !== undefined) return explicit
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'gateway')
}

/**
 * Copy the token forward from the pre-0.5 location (`$DSH_HOME/profiles/gateway`).
 *
 * Only the default location migrates, and only files the new directory does
 * not already have: an explicit DSH_GATEWAY_DATA_DIR or an existing new-style
 * file always wins. The old files are left in place — that directory may
 * double as a real dsh profile, so the gateway must not delete from it.
 * Settings migrate separately, into the profile directory (GatewaySettingsStore).
 *
 * @param dataDir - resolved data directory.
 * @param logger - logger for the one-time migration notice.
 */
export async function migrateLegacyDataDir(dataDir, logger) {
  if (envValue(DATA_DIR_ENV) !== undefined) return
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  if (dataDir !== join(dshHome, 'gateway')) return
  const legacy = join(dshHome, 'profiles', 'gateway')
  const migrated = []
  for (const name of ['token.txt']) {
    try {
      await stat(join(dataDir, name))
      continue // The new location already owns this file.
    } catch {
      // Not present yet; try the legacy copy.
    }
    try {
      await mkdir(dataDir, { recursive: true })
      await copyFile(join(legacy, name), join(dataDir, name))
      migrated.push(name)
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
  }
  if (migrated.length > 0) {
    logger?.info(`dsh-gateway: moved ${migrated.join(', ')} from ${legacy} to ${dataDir}; the old copies are unused and can be deleted`)
  }
}

export const Config = z.object({
  host: z.string().default(envString(HOST_ENV, '127.0.0.1')),
  // The default port is derived from the dsh web port at startup; this env
  // var only overrides it when explicitly set.
  port: z.natural().max(65535).default(envInt(PORT_ENV)),
  dataDir: z.string().default(defaultDataDir()),
  pwa: z.boolean().default(envBool(PWA_ENV, true)),
  // Declare the proxied page as a host-owning page so dsh uses Host settings
  // (Models page, "open configuration file") instead of its read-only memory
  // fallback. On by default because a remote dsh web UI is unusable without it;
  // it does hand every signed-in user the same configuration-write surface the
  // Desktop shell has, so the settings page can turn it off.
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

/**
 * Replace dsh's per-process launch token with the gateway's persistent one.
 *
 * dsh keeps the token as a plain property on its Connection service's
 * BrowserAuth (`connection.browserAuth.launchToken`); every consumer —
 * `authenticatedUrl`, the index exchange, `/connect` — reads that property at
 * call time, so assigning it before any request arrives changes the accepted
 * token for the whole process. This is a deliberate dependency on a dsh
 * internal: the field is verified through the public `authenticatedUrl()`
 * afterwards, and a dsh version that moves it degrades to the stock behavior
 * (fresh token per restart) with a warning instead of breaking sign-in.
 *
 * @param connection - dsh's Connection service.
 * @param token - the persistent token to install.
 * @param logger - logger for the compatibility warning.
 * @returns true when the installed token is the one dsh now advertises.
 */
export function installLaunchToken(connection, token, logger) {
  const auth = connection?.browserAuth
  if (auth === undefined || typeof auth.launchToken !== 'string') {
    logger?.warn('dsh-gateway: this dsh version exposes no browserAuth.launchToken; the sign-in token rotates on every restart')
    return false
  }
  auth.launchToken = token
  try {
    const advertised = new URL(connection.authenticatedUrl('http://127.0.0.1/')).searchParams.get('token')
    if (advertised === token) return true
  } catch {
    // Fall through to the warning.
  }
  logger?.warn('dsh-gateway: installing the persistent launch token did not take effect; the sign-in token rotates on every restart')
  return false
}

class DshGateway extends Service {
  static Config = Config

  constructor(ctx, config) {
    super(ctx, 'gateway')
    this.config = config
    // Settings are profile-scoped configuration: they live inside the profile
    // directory so a dotfiles checkout carries them. The token is a credential
    // and stays in the home-level data directory. Pre-0.5.0 settings locations
    // are adopted on first init; the current file always wins.
    const profileDir = ctx.get('profileContext')?.dir
    const settingsFile = profileDir !== undefined
      ? join(profileDir, 'gateway', 'settings.json')
      : join(config.dataDir, 'settings.json')
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    this.settings = new GatewaySettingsStore(settingsFile, [
      join(config.dataDir, 'settings.json'),
      join(dshHome, 'profiles', 'gateway', 'settings.json'),
    ])
    this.launchToken = new LaunchTokenStore(
      join(config.dataDir, 'token.txt'),
      envValue(TOKEN_ENV),
      ctx.logger
    )
    this.persistentToken = false
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
  }

  async [Service.init]() {
    await migrateLegacyDataDir(this.config.dataDir, this.ctx.logger)
    await Promise.all([this.settings.init(), this.launchToken.init()])

    const saved = this.settings.snapshot()
    this.runtimePwa = this.envOverrides.pwa ?? saved.pwa ?? this.config.pwa
    this.bootHostMode = this.envOverrides.hostMode ?? saved.hostMode ?? this.config.hostMode
    this.configuredHostMode = this.bootHostMode
    this.config = { ...this.config, pwa: this.runtimePwa, hostMode: this.bootHostMode }

    const target = upstreamTarget(this.ctx.webServer)
    this.target = target
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

    // Connection mounts after this row in the shipped web composition, so the
    // launch token only exists once that service appears. Waiving readiness is
    // safe: this is a log line, not part of serving traffic.
    this.ctx.inject(['connection'], (connCtx) => {
      this.persistentToken = installLaunchToken(
        connCtx.get('connection'),
        this.launchToken.token,
        this.ctx.logger
      )
      this.printSignInUrl(target)
    })
  }

  /**
   * A tokenized application URL for the loopback `authority`, from dsh's
   * Connection service. dsh exchanges that token for its own signed cookie on
   * `GET /`, and the exchange also works through this proxy: the gateway
   * forwards `Host` as loopback, which is exactly the authority dsh binds the
   * cookie to.
   */
  tokenizedUrl(authority) {
    const connection = this.ctx.get('connection')
    if (connection === undefined) return undefined
    return connection.authenticatedUrl(`http://${authority}/`)
  }

  async handle(req, res, target) {
    const url = new URL(req.url ?? '/', 'http://dsh-gateway.invalid')
    const pathname = url.pathname

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

    if (pathname === GATEWAY_API_PREFIX || pathname.startsWith(`${GATEWAY_API_PREFIX}/`)) {
      // The settings page is reachable only to a browser dsh already accepts;
      // there is no gateway-owned session to check instead.
      if (!(await probeBrowserSession(target, req.headers.cookie))) {
        this.sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      await this.handleGatewayApi(req, res, pathname)
      return
    }

    // Everything else is dsh's request. The gateway translates identity to
    // loopback and relays; dsh's own cookie decides whether the browser is
    // authenticated.
    await proxyRequest(req, res, target, {
      pwa: this.runtimePwa,
      hostMode: this.bootHostMode
    })
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
      uptimeMs: Date.now() - this.startedAt,
      dataDir: this.config.dataDir,
      auth: {
        provider: 'dsh',
        // dsh's cookie name is a deterministic hash of the authority it was
        // minted for; the gateway always forwards the loopback authority.
        cookieName: dshCookieName(targetAuthority(this.target)),
        persistentToken: this.persistentToken,
        tokenSource: this.persistentToken ? this.launchToken.source : 'process'
      },
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
    const raw = await readRequestBody(req)
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

  /** The browser-facing origin uses HTTPS? */
  isSecureRequest(req) {
    const proto = req.headers['x-forwarded-proto']
    if (typeof proto === 'string' && proto !== '') return proto.split(',', 1)[0].trim() === 'https'
    return false
  }

  async handleGatewayApi(req, res, pathname) {
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

    if (pathname === `${GATEWAY_API_PREFIX}/logout`) {
      this.signOut(req, res)
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

    this.sendJson(res, 404, { error: 'not found' })
  }

  /**
   * End this browser's dsh session by expiring the cookie dsh minted.
   *
   * dsh has no logout endpoint — its documented model is "clearing the browser
   * cookie ends one browser session" — so the gateway does exactly that for the
   * one cookie name it knows, the loopback authority's. Other browsers are
   * unaffected; revoking every session needs deleting dsh's
   * `client-connection/browser-session` credential and restarting dsh.
   */
  signOut(req, res) {
    const name = dshCookieName(targetAuthority(this.target))
    const secure = this.isSecureRequest(req) ? '; Secure' : ''
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secure}`
    })
    res.end(JSON.stringify({ ok: true }))
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

  async handleUpgrade(req, socket, head, target) {
    proxyUpgrade(req, socket, head, target)
  }

  printUrl(target) {
    const host = this.config.host === '0.0.0.0' ? '127.0.0.1' : this.config.host
    const lan = this.config.host === '0.0.0.0' ? lanAddresses()[0] : undefined
    const lanText = lan === undefined ? '' : ` (LAN: http://${lan}:${String(this.proxyPort)})`
    const base = `http://${host}:${String(this.proxyPort)}`
    console.log(`dsh-gateway: ${base} -> http://${target.host}:${String(target.port)}${lanText}`)
    if (this.bootHostMode) {
      console.log('dsh-gateway: host mode is ON — every signed-in user can edit this profile\'s settings and plugins')
    }
  }

  /**
   * Print the one URL that signs a browser in.
   *
   * Authentication is dsh's launch token exchanged for dsh's own signed
   * cookie. dsh only accepts that token on `GET /`, and the exchange works
   * through this proxy because the gateway forwards `Host` as the loopback
   * authority dsh binds the cookie to. Rewriting dsh's URL to the gateway port
   * is therefore all that is needed. With the persistent token installed the
   * URL is stable across restarts and safe to bookmark.
   */
  printSignInUrl(target) {
    const tokenized = this.tokenizedUrl(targetAuthority(target))
    const token = tokenized === undefined ? undefined : new URL(tokenized).searchParams.get('token')
    if (token === undefined || token === '') {
      console.log('dsh-gateway: open the tokenized URL printed by dsh web to sign in through this gateway')
      return
    }
    const host = this.config.host === '0.0.0.0' ? '127.0.0.1' : this.config.host
    const urlHost = host.includes(':') ? `[${host}]` : host
    const stability = this.persistentToken ? ' (stable across restarts)' : ''
    console.log(`dsh-gateway: sign in with http://${urlHost}:${String(this.proxyPort)}/?token=${encodeURIComponent(token)}${stability}`)
  }

  async close() {
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
