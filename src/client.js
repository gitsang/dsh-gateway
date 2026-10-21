/**
 * Browser half of dsh-gateway.
 *
 * One plugin row owns both the gateway and its settings. The row is not split
 * into qol-style components: PWA delivery and Host-mode injection share the
 * proxy lifecycle and must never be turned off independently of access. This
 * section therefore exposes the two safe user-facing modes, plus gateway
 * status and access operations.
 */
window.__ModuleLoader__.load({
  id: '@gitsang/dsh-gateway',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports

    const NS = 'gatewaySettings'
    const API = '/__dsh_gateway'
    const CSS_ID = '@gitsang/dsh-gateway/GatewaySettings.css'

    const zh = {
      nav: '网关',
      title: '网关',
      intro: '管理 dsh 的安全入口、浏览器交付方式和上游连接。',
      status: '运行状态',
      listen: '监听地址',
      upstream: '上游 dsh',
      sessions: '有效会话',
      uptime: '运行时长',
      version: '版本',
      dataDir: '数据目录',
      browser: '浏览器体验',
      pwaTitle: 'PWA / 可安装应用',
      pwaDesc: '提供 manifest、Service Worker 和离线应用外壳。关闭后下一次页面请求停止注入。',
      clearCache: '清除离线缓存',
      cacheCleared: '已清除网关离线缓存。',
      cacheUnsupported: '当前浏览器不支持 Cache Storage。',
      access: '访问控制',
      currentPassword: '当前密码',
      newPassword: '新密码',
      confirmPassword: '确认新密码',
      changePassword: '修改密码',
      passwordChanged: '密码已更新，其他设备已退出登录。',
      logoutAll: '退出所有设备',
      logoutAllDesc: '撤销全部会话，包括当前浏览器。',
      logoutAllConfirm: '确定要退出所有设备吗？',
      advanced: '兼容性',
      hostModeTitle: 'Host mode 注入',
      hostModeDesc: '允许 dsh 页面编辑 Host 设置、模型配置和插件。需要重启 dsh 后生效。',
      hostModeWarning: '开启后，任何能登录网关的人都能修改配置并安装插件；插件代码会在主机上运行。',
      envManaged: '由环境变量管理',
      restartRequired: '重启后生效',
      restartHint: '已保存。重启 dsh web 后 Host mode 才会切换。',
      on: '已开启',
      off: '已关闭',
      saved: '设置已保存。',
      loading: '正在读取网关状态…',
      unknownError: '操作失败，请稍后重试。',
      day: '天',
      hour: '小时',
      minute: '分钟',
      second: '秒'
    }

    const en = {
      nav: 'Gateway',
      title: 'Gateway',
      intro: 'Manage the secure entry point, browser delivery and upstream connection for dsh.',
      status: 'Status',
      listen: 'Listening on',
      upstream: 'Upstream dsh',
      sessions: 'Active sessions',
      uptime: 'Uptime',
      version: 'Version',
      dataDir: 'Data directory',
      browser: 'Browser experience',
      pwaTitle: 'PWA / installable app',
      pwaDesc: 'Serves the manifest, service worker and offline app shell. Turning it off stops injection on the next page request.',
      clearCache: 'Clear offline cache',
      cacheCleared: 'Gateway offline caches cleared.',
      cacheUnsupported: 'This browser does not support Cache Storage.',
      access: 'Access control',
      currentPassword: 'Current password',
      newPassword: 'New password',
      confirmPassword: 'Confirm new password',
      changePassword: 'Change password',
      passwordChanged: 'Password updated. Other devices were signed out.',
      logoutAll: 'Sign out everywhere',
      logoutAllDesc: 'Revoke every session, including this browser.',
      logoutAllConfirm: 'Sign out of every device?',
      advanced: 'Compatibility',
      hostModeTitle: 'Host mode injection',
      hostModeDesc: 'Lets the dsh page edit Host settings, model configuration and plugins. Requires a dsh restart.',
      hostModeWarning: 'When enabled, anyone who can sign in may change configuration and install plugin bundles; plugin code runs on this host.',
      envManaged: 'Managed by environment',
      restartRequired: 'Restart required',
      restartHint: 'Saved. Restart dsh web to apply the Host mode change.',
      on: 'On',
      off: 'Off',
      saved: 'Settings saved.',
      loading: 'Loading gateway status…',
      unknownError: 'The operation failed. Try again.',
      day: 'd',
      hour: 'h',
      minute: 'm',
      second: 's'
    }

    const CSS = [
      '.dshGatewaySection{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:18px;display:flex}',
      '.dshGatewayHeading{margin:0;font-size:18px;font-weight:600;line-height:26px}',
      '.dshGatewayIntro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}',
      '.dshGatewayGroup{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:12px}',
      '.dshGatewayGroupTitle{margin:0;font-size:14px;font-weight:600;line-height:22px}',
      '.dshGatewayRow{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:2px 0}',
      '.dshGatewayRowText{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}',
      '.dshGatewayRowTitle{font-size:14px;line-height:22px}',
      '.dshGatewayRowDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dshGatewayRowValue{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.dshGatewayBadge{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;white-space:nowrap}',
      '.dshGatewayBadgeWarn{color:var(--dsw-alias-state-error-primary);border-color:currentColor}',
      '.dshGatewaySwitch{width:40px;height:22px;border-radius:999px;border:0;background:var(--dsw-alias-border-l2);position:relative;cursor:pointer;flex:none;transition:background .15s ease}',
      '.dshGatewaySwitch[data-on=true]{background:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary))}',
      '.dshGatewaySwitch:after{content:"";position:absolute;width:18px;height:18px;border-radius:50%;background:#fff;top:2px;left:2px;transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.2)}',
      '.dshGatewaySwitch[data-on=true]:after{transform:translateX(18px)}',
      '.dshGatewaySwitch:disabled{opacity:.45;cursor:not-allowed}',
      '.dshGatewayActions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.dshGatewayButton{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:6px 12px;font:inherit;font-size:13px;line-height:20px;cursor:pointer}',
      '.dshGatewayButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshGatewayButton:disabled{opacity:.45;cursor:not-allowed}',
      '.dshGatewayButtonDanger{color:var(--dsw-alias-state-error-primary)}',
      '.dshGatewayButtonPrimary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dshGatewayForm{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:end}',
      '@media(max-width:680px){.dshGatewayForm{grid-template-columns:1fr}}',
      '.dshGatewayField{display:flex;flex-direction:column;gap:4px}',
      '.dshGatewayField label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dshGatewayInput{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-specific-login-input,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);padding:7px 10px;font:inherit;font-size:13px;line-height:20px}',
      '.dshGatewayMessage{margin:0;font-size:13px;line-height:20px}',
      '.dshGatewayError{color:var(--dsw-alias-state-error-primary)}',
      '.dshGatewayNotice{color:var(--dsw-alias-label-tertiary)}',
      '.dshGatewayFootnote{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dshGatewayCode{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}'
    ].join('')
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') === null
    ) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@gitsang/dsh-gateway'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }


    /** Call the gateway's authenticated settings API. */
    async function request(path, options = {}) {
      const headers = { accept: 'application/json' }
      if (options.method === 'POST') {
        headers['content-type'] = 'application/json'
        headers['x-dsh-gateway'] = '1'
      }
      const response = await fetch(API + path, {
        credentials: 'same-origin',
        ...options,
        headers: { ...headers, ...(options.headers || {}) }
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        // The status code still carries the failure.
      }
      if (!response.ok) {
        throw new Error(body?.error || `HTTP ${String(response.status)}`)
      }
      return body
    }

    function formatUptime(ms, t) {
      const total = Math.max(0, Math.floor(ms / 1000))
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (days > 0) return `${String(days)}${t('day')} ${String(hours)}${t('hour')}`
      if (hours > 0) return `${String(hours)}${t('hour')} ${String(minutes)}${t('minute')}`
      if (minutes > 0) return `${String(minutes)}${t('minute')} ${String(seconds)}${t('second')}`
      return `${String(seconds)}${t('second')}`
    }

    function StatusRow({ label, value }) {
      return React.createElement(
        'div',
        { className: 'dshGatewayRow' },
        React.createElement('div', { className: 'dshGatewayRowText' },
          React.createElement('div', { className: 'dshGatewayRowTitle' }, label)),
        React.createElement('div', { className: 'dshGatewayRowValue dshGatewayCode' }, value)
      )
    }

    function FeatureSwitch({ checked, disabled, label, onChange }) {
      return React.createElement('button', {
        type: 'button',
        className: 'dshGatewaySwitch',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        'data-on': checked ? 'true' : 'false',
        disabled,
        onClick: onChange
      })
    }

    function GatewaySettingsView({ t }) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [form, setForm] = React.useState({ currentPassword: '', newPassword: '', confirm: '' })

      const refresh = React.useCallback(async () => {
        const next = await request('/state')
        setState(next)
        return next
      }, [])

      React.useEffect(() => {
        let alive = true
        refresh().catch((err) => {
          if (alive) setError(err?.message || t('unknownError'))
        })
        return () => {
          alive = false
        }
      }, [refresh, t])

      async function dropOfflineShell() {
        try {
          if (typeof caches !== 'undefined') {
            const keys = await caches.keys()
            await Promise.all(keys
              .filter((key) => key.startsWith('dsh-gateway-'))
              .map((key) => caches.delete(key)))
          }
          if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations()
            await Promise.all(registrations.map((registration) => registration.unregister()))
          }
        } catch {
          // The server-side switch already took effect; a stale worker will
          // disappear on its next update check even if this cleanup fails.
        }
      }

      async function saveSettings(patch) {
        setBusy('settings')
        setError('')
        setNotice('')
        try {
          setState(await request('/settings', { method: 'POST', body: JSON.stringify(patch) }))
          if (patch.pwa === false) await dropOfflineShell()
          setNotice(t('saved'))
        } catch (err) {
          setError(err?.message || t('unknownError'))
        } finally {
          setBusy('')
        }
      }

      async function clearCache() {
        setError('')
        setNotice('')
        if (typeof caches === 'undefined') {
          setNotice(t('cacheUnsupported'))
          return
        }
        try {
          const keys = await caches.keys()
          await Promise.all(keys
            .filter((key) => key.startsWith('dsh-gateway-'))
            .map((key) => caches.delete(key)))
          setNotice(t('cacheCleared'))
        } catch (err) {
          setError(err?.message || t('unknownError'))
        }
      }

      async function changePassword(event) {
        event.preventDefault()
        setBusy('password')
        setError('')
        setNotice('')
        try {
          await request('/password', { method: 'POST', body: JSON.stringify(form) })
          setForm({ currentPassword: '', newPassword: '', confirm: '' })
          setNotice(t('passwordChanged'))
          await refresh()
        } catch (err) {
          setError(err?.message || t('unknownError'))
        } finally {
          setBusy('')
        }
      }

      async function logoutAll() {
        if (!window.confirm(t('logoutAllConfirm'))) return
        setBusy('logout')
        setError('')
        try {
          await request('/logout-all', { method: 'POST', body: '{}' })
          window.location.assign('/login')
        } catch (err) {
          setError(err?.message || t('unknownError'))
          setBusy('')
        }
      }

      if (state === null) {
        return React.createElement('section', { className: 'dshGatewaySection' },
          React.createElement('h2', { className: 'dshGatewayHeading' }, t('title')),
          React.createElement('p', { className: 'dshGatewayIntro' }, error || t('loading')))
      }

      const busyNow = busy !== ''
      return React.createElement('section', { className: 'dshGatewaySection' },
        React.createElement('h2', { className: 'dshGatewayHeading' }, t('title')),
        React.createElement('p', { className: 'dshGatewayIntro' }, t('intro')),
        error === '' ? null : React.createElement('p', { className: 'dshGatewayMessage dshGatewayError', role: 'alert' }, error),
        notice === '' ? null : React.createElement('p', { className: 'dshGatewayMessage dshGatewayNotice', role: 'status' }, notice),

        React.createElement('div', { className: 'dshGatewayGroup' },
          React.createElement('h3', { className: 'dshGatewayGroupTitle' }, t('status')),
          React.createElement(StatusRow, { label: t('listen'), value: `${state.listen.host}:${String(state.listen.port)}` }),
          React.createElement(StatusRow, { label: t('upstream'), value: `${state.upstream.host}:${String(state.upstream.port)}` }),
          React.createElement(StatusRow, { label: t('sessions'), value: String(state.sessions) }),
          React.createElement(StatusRow, { label: t('uptime'), value: formatUptime(state.uptimeMs, t) }),
          React.createElement(StatusRow, { label: t('version'), value: state.version }),
          React.createElement(StatusRow, { label: t('dataDir'), value: state.dataDir })
        ),

        React.createElement('div', { className: 'dshGatewayGroup' },
          React.createElement('h3', { className: 'dshGatewayGroupTitle' }, t('browser')),
          React.createElement('div', { className: 'dshGatewayRow' },
            React.createElement('div', { className: 'dshGatewayRowText' },
              React.createElement('div', { className: 'dshGatewayRowTitle' }, t('pwaTitle')),
              React.createElement('div', { className: 'dshGatewayRowDesc' }, t('pwaDesc'))),
            React.createElement('div', { className: 'dshGatewayActions' },
              state.pwa.locked ? React.createElement('span', { className: 'dshGatewayBadge' }, t('envManaged')) : null,
              React.createElement(FeatureSwitch, {
                checked: state.pwa.value,
                disabled: busyNow || state.pwa.locked,
                label: t('pwaTitle'),
                onChange: () => { void saveSettings({ pwa: !state.pwa.value }) }
              }))
          ),
          React.createElement('div', { className: 'dshGatewayActions' },
            React.createElement('button', {
              type: 'button',
              className: 'dshGatewayButton',
              disabled: busyNow,
              onClick: () => { void clearCache() }
            }, t('clearCache')))
        ),

        React.createElement('div', { className: 'dshGatewayGroup' },
          React.createElement('h3', { className: 'dshGatewayGroupTitle' }, t('access')),
          React.createElement('form', { className: 'dshGatewayForm', onSubmit: changePassword },
            React.createElement('div', { className: 'dshGatewayField' },
              React.createElement('label', { htmlFor: 'dsh-gateway-current' }, t('currentPassword')),
              React.createElement('input', {
                id: 'dsh-gateway-current',
                className: 'dshGatewayInput',
                type: 'password',
                autoComplete: 'current-password',
                value: form.currentPassword,
                onChange: (event) => setForm({ ...form, currentPassword: event.target.value })
              })),
            React.createElement('div', { className: 'dshGatewayField' },
              React.createElement('label', { htmlFor: 'dsh-gateway-new' }, t('newPassword')),
              React.createElement('input', {
                id: 'dsh-gateway-new',
                className: 'dshGatewayInput',
                type: 'password',
                autoComplete: 'new-password',
                value: form.newPassword,
                onChange: (event) => setForm({ ...form, newPassword: event.target.value })
              })),
            React.createElement('div', { className: 'dshGatewayField' },
              React.createElement('label', { htmlFor: 'dsh-gateway-confirm' }, t('confirmPassword')),
              React.createElement('input', {
                id: 'dsh-gateway-confirm',
                className: 'dshGatewayInput',
                type: 'password',
                autoComplete: 'new-password',
                value: form.confirm,
                onChange: (event) => setForm({ ...form, confirm: event.target.value })
              })),
            React.createElement('div', { className: 'dshGatewayActions' },
              React.createElement('button', {
                type: 'submit',
                className: 'dshGatewayButton dshGatewayButtonPrimary',
                disabled: busyNow
              }, t('changePassword')))
          ),
          React.createElement('div', { className: 'dshGatewayRow' },
            React.createElement('div', { className: 'dshGatewayRowText' },
              React.createElement('div', { className: 'dshGatewayRowTitle' }, t('logoutAll')),
              React.createElement('div', { className: 'dshGatewayRowDesc' }, t('logoutAllDesc'))),
            React.createElement('button', {
              type: 'button',
              className: 'dshGatewayButton dshGatewayButtonDanger',
              disabled: busyNow,
              onClick: () => { void logoutAll() }
            }, t('logoutAll')))
        ),

        React.createElement('div', { className: 'dshGatewayGroup' },
          React.createElement('h3', { className: 'dshGatewayGroupTitle' }, t('advanced')),
          React.createElement('div', { className: 'dshGatewayRow' },
            React.createElement('div', { className: 'dshGatewayRowText' },
              React.createElement('div', { className: 'dshGatewayRowTitle' }, t('hostModeTitle')),
              React.createElement('div', { className: 'dshGatewayRowDesc' }, t('hostModeDesc'))),
            React.createElement('div', { className: 'dshGatewayActions' },
              state.hostMode.locked ? React.createElement('span', { className: 'dshGatewayBadge' }, t('envManaged')) : null,
              state.hostMode.restartRequired ? React.createElement('span', { className: 'dshGatewayBadge dshGatewayBadgeWarn' }, t('restartRequired')) : null,
              React.createElement(FeatureSwitch, {
                checked: state.hostMode.configured,
                disabled: busyNow || state.hostMode.locked,
                label: t('hostModeTitle'),
                onChange: () => { void saveSettings({ hostMode: !state.hostMode.configured }) }
              }))
          ),
          state.hostMode.restartRequired
            ? React.createElement('p', { className: 'dshGatewayFootnote' }, t('restartHint'))
            : null,
          React.createElement('p', { className: 'dshGatewayFootnote' }, t('hostModeWarning'))
        )
      )
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'gateway: dictionaries'
      )

      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'gateway',
          order: 50,
          label: () => t('nav'),
          locale: NS
        },
        (props) => React.createElement(GatewaySettingsView, { ...props, t })
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
