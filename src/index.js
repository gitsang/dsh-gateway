import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AuthStore, SessionStore } from './stores.js'
import { parseCookies, proxyRequest, proxyUpgrade } from './proxy.js'
import { readFormBody, renderLoginPage, safeNext } from './pages.js'
import { ICON_192_PNG, ICON_512_PNG, MANIFEST, SW_JS } from './pwa.js'

export const name = 'web-auth'
export const inject = ['webServer']

export const COOKIE_NAME = 'dsh_web_session'
const DEFAULT_PORT = 3081
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
  port: z.natural().max(65535).default(envInt('DSH_WEB_AUTH_PORT', DEFAULT_PORT)),
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
  }

  async [Service.init]() {
    await this.auth.init()
    await this.sessions.init()

    const target = upstreamTarget(this.ctx.webServer)
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
      this.handleUpgrade(req, socket, head, target)
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
        this.proxyPort = typeof address === 'object' && address !== null ? address.port : this.config.port
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.config.port, this.config.host)
    })

    this.ctx.effect(() => async () => this.close(), 'web-auth.proxy')
    this.printUrl(target)
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

      if (pathname === '/icon-192.png') {
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=86400'
        })
        res.end(ICON_192_PNG)
        return
      }

      if (pathname === '/icon-512.png') {
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=86400'
        })
        res.end(ICON_512_PNG)
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
      proxyRequest(req, res, target, { pwa: this.config.pwa })
      return
    }

    this.deny(req, res)
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

  handleUpgrade(req, socket, head, target) {
    const session = this.getSession(req)
    if (session === undefined) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 12\r\n\r\nunauthorized')
      socket.destroy()
      return
    }
    this.sessions.touch(session.token)
    proxyUpgrade(req, socket, head, target)
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
