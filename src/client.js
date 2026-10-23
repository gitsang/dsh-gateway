/**
 * Browser half of dsh-gateway.
 *
 * One plugin row owns both the gateway and its configuration. The page lives
 * on that Plugins row instead of inside Settings; PWA delivery and Host-mode
 * injection share the proxy lifecycle and must never be turned off
 * independently of access. The page therefore exposes the two safe modes,
 * gateway status, and access operations.
 *
 * The form uses the same SettingsForm/field/switch primitives and the same
 * section rhythm as the official plugin configuration pages.
 */
window.__ModuleLoader__.load({
  id: '@gitsang/dsh-gateway',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button, SettingsForm, Switch } = primitives
    const module = { exports: {} }
    const exports = module.exports

    const NS = 'gatewaySettings'
    const API = '/__dsh_gateway'
    const CSS_ID = '@gitsang/dsh-gateway/GatewayConfig.css'

    const zh = {
      nav: '网关',
      title: '网关',
      intro: '管理 dsh 的安全入口、浏览器交付方式和上游连接。',
      summary: '管理 dsh 的安全入口、浏览器交付方式和上游连接',
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
      save: '保存',
      saving: '保存中…',
      saveFailed: '保存失败，请重试。',
      readOnly: '当前部署的设置为只读。',
      unavailable: '该组件当前不可配置。',
      credentialRequired: '必填',
      day: '天',
      hour: '小时',
      minute: '分钟',
      second: '秒'
    }

    const en = {
      nav: 'Gateway',
      title: 'Gateway',
      intro: 'Manage the secure entry point, browser delivery and upstream connection for dsh.',
      summary: 'Manage the secure entry point, browser delivery and upstream connection for dsh',
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
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'Could not save. Try again.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This component cannot be configured right now.',
      credentialRequired: 'Required',
      day: 'd',
      hour: 'h',
      minute: 'm',
      second: 's'
    }

    const CSS = [
      '.dshGatewayPage{display:flex;flex-direction:column;gap:0;max-width:760px;color:var(--dsw-alias-label-primary)}',
      '.dshGatewaySection{display:flex;flex-direction:column;gap:10px;padding:16px 0}',
      '.dshGatewaySection+.dshGatewaySection{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dshGatewayHeading{margin:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.dshGatewayRows{display:flex;flex-direction:column;gap:8px;margin:0}',
      '.dshGatewayRow{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;font-size:12px;line-height:1.5}',
      '.dshGatewayRow dt{color:var(--dsw-alias-label-tertiary)}',
      '.dshGatewayRow dd{margin:0;min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}',
      '.dshGatewayCode{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px}',
      '.dshGatewayField{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
      '.dshGatewayField+.dshGatewayField{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dshGatewayToggleRow{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
      '.dshGatewayFieldText{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}',
      '.dshGatewayLabel{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.dshGatewayHint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dshGatewayWarning{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}',
      '.dshGatewayActions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.dshGatewayForm{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:end}',
      '@media(max-width:680px){.dshGatewayForm{grid-template-columns:1fr}}',
      '.dshGatewayInput{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}',
      '.dshGatewayInput:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.dshGatewayMessage{margin:0;font-size:12px;line-height:1.5}',
      '.dshGatewayError{color:var(--dsw-alias-state-error-primary)}',
      '.dshGatewayNotice{color:var(--dsw-alias-label-tertiary)}',
      '.dshGatewayBadge{border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;white-space:nowrap}',
      '.dshGatewayBadgeWarn{color:var(--dsw-alias-state-error-primary);border-color:currentColor}'
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

    function StatusFact({ label, value }) {
      return React.createElement(React.Fragment, null,
        React.createElement('dt', null, label),
        React.createElement('dd', { className: 'dshGatewayCode' }, value)
      )
    }

    function ToggleField({ label, hint, checked, disabled, badge, warning, onChange }) {
      return React.createElement('div', { className: 'dshGatewayField' },
        React.createElement('div', { className: 'dshGatewayToggleRow' },
          React.createElement('div', { className: 'dshGatewayFieldText' },
            React.createElement('span', { className: 'dshGatewayLabel' }, label),
            hint === undefined ? null : React.createElement('p', { className: 'dshGatewayHint' }, hint)
          ),
          React.createElement('div', { className: 'dshGatewayActions' },
            badge === undefined ? null : badge,
            React.createElement(Switch, { checked, disabled, label, onChange })
          )
        ),
        warning === undefined ? null : React.createElement('p', { className: 'dshGatewayWarning' }, warning)
      )
    }

    function PasswordInput({ id, label, autoComplete, value, onChange }) {
      return React.createElement('div', { className: 'dshGatewayField' },
        React.createElement('label', { className: 'dshGatewayLabel', htmlFor: id }, label),
        React.createElement('input', {
          id,
          className: 'dshGatewayInput',
          type: 'password',
          autoComplete,
          value,
          onChange: (event) => onChange(event.target.value)
        })
      )
    }

    function GatewayConfig({ view, t }) {
      const [state, setState] = React.useState(null)
      const [staged, setStaged] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [saveFailed, setSaveFailed] = React.useState(false)
      const [form, setForm] = React.useState({ currentPassword: '', newPassword: '', confirm: '' })

      const applyState = React.useCallback((next) => {
        setState(next)
        setStaged({ pwa: next.pwa.value, hostMode: next.hostMode.configured })
      }, [])

      const refresh = React.useCallback(async () => {
        const next = await request('/state')
        applyState(next)
        return next
      }, [applyState])

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

      async function saveSettings() {
        if (staged === null || state === null) return
        setSaving(true)
        setSaveFailed(false)
        setError('')
        setNotice('')
        try {
          const next = await request('/settings', {
            method: 'POST',
            body: JSON.stringify({ pwa: staged.pwa, hostMode: staged.hostMode })
          })
          if (staged.pwa === false) await dropOfflineShell()
          applyState(next)
          setNotice(t('saved'))
        } catch (err) {
          setSaveFailed(true)
          setError(err?.message || t('unknownError'))
        } finally {
          setSaving(false)
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

      if (view === 'summary') return t('summary')

      if (state === null || staged === null) {
        return React.createElement('p', { className: 'dshGatewayHint', role: 'status' }, error || t('loading'))
      }

      const busyNow = busy !== ''
      const dirty = staged.pwa !== state.pwa.value || staged.hostMode !== state.hostMode.configured
      const shell = {
        available: true,
        writable: true,
        dirty,
        invalid: false,
        saving,
        failed: saveFailed
      }

      return React.createElement('div', { className: 'dshGatewayPage' },
        React.createElement(SettingsForm, {
          labels: {
            unavailable: t('unavailable'),
            readOnly: t('readOnly'),
            saveFailed: t('saveFailed'),
            save: t('save'),
            saving: t('saving')
          },
          state: shell,
          onSave: () => { void saveSettings() },
          onDiscard: () => {
            setStaged({ pwa: state.pwa.value, hostMode: state.hostMode.configured })
            setSaveFailed(false)
          }
        },
        React.createElement('section', { className: 'dshGatewaySection' },
          React.createElement('h3', { className: 'dshGatewayHeading' }, t('browser')),
          React.createElement(ToggleField, {
            label: t('pwaTitle'),
            hint: t('pwaDesc'),
            checked: staged.pwa,
            disabled: busyNow || saving || state.pwa.locked,
            badge: state.pwa.locked ? React.createElement('span', { className: 'dshGatewayBadge' }, t('envManaged')) : undefined,
            onChange: (checked) => { setStaged((previous) => ({ ...previous, pwa: checked })) }
          }),
          React.createElement('div', { className: 'dshGatewayActions' },
            React.createElement(Button, {
              size: 'sm',
              variant: 'outline',
              disabled: busyNow,
              onClick: () => { void clearCache() }
            }, t('clearCache'))
          )
        ),
        React.createElement('section', { className: 'dshGatewaySection' },
          React.createElement('h3', { className: 'dshGatewayHeading' }, t('advanced')),
          React.createElement(ToggleField, {
            label: t('hostModeTitle'),
            hint: t('hostModeDesc'),
            checked: staged.hostMode,
            disabled: busyNow || saving || state.hostMode.locked,
            badge: state.hostMode.locked
              ? React.createElement('span', { className: 'dshGatewayBadge' }, t('envManaged'))
              : state.hostMode.restartRequired
                ? React.createElement('span', { className: 'dshGatewayBadge dshGatewayBadgeWarn' }, t('restartRequired'))
                : undefined,
            warning: t('hostModeWarning'),
            onChange: (checked) => { setStaged((previous) => ({ ...previous, hostMode: checked })) }
          }),
          state.hostMode.restartRequired
            ? React.createElement('p', { className: 'dshGatewayHint' }, t('restartHint'))
            : null
        ),
        React.createElement('section', { className: 'dshGatewaySection' },
          React.createElement('h3', { className: 'dshGatewayHeading' }, t('access')),
          React.createElement('form', { className: 'dshGatewayForm', onSubmit: changePassword },
            React.createElement(PasswordInput, {
              id: 'dsh-gateway-current',
              label: t('currentPassword'),
              autoComplete: 'current-password',
              value: form.currentPassword,
              onChange: (value) => setForm({ ...form, currentPassword: value })
            }),
            React.createElement(PasswordInput, {
              id: 'dsh-gateway-new',
              label: t('newPassword'),
              autoComplete: 'new-password',
              value: form.newPassword,
              onChange: (value) => setForm({ ...form, newPassword: value })
            }),
            React.createElement(PasswordInput, {
              id: 'dsh-gateway-confirm',
              label: t('confirmPassword'),
              autoComplete: 'new-password',
              value: form.confirm,
              onChange: (value) => setForm({ ...form, confirm: value })
            }),
            React.createElement('div', { className: 'dshGatewayActions' },
              React.createElement(Button, {
                type: 'submit',
                size: 'sm',
                variant: 'primary',
                disabled: busyNow
              }, t('changePassword'))
            )
          ),
          React.createElement('div', { className: 'dshGatewayField' },
            React.createElement('span', { className: 'dshGatewayLabel' }, t('logoutAll')),
            React.createElement('p', { className: 'dshGatewayHint' }, t('logoutAllDesc')),
            React.createElement('div', { className: 'dshGatewayActions' },
              React.createElement(Button, {
                size: 'sm',
                variant: 'outline',
                disabled: busyNow,
                onClick: () => { void logoutAll() }
              }, t('logoutAll'))
            )
          )
        ),
        React.createElement('section', { className: 'dshGatewaySection' },
          React.createElement('h3', { className: 'dshGatewayHeading' }, t('status')),
          React.createElement('dl', { className: 'dshGatewayRows' },
            React.createElement(StatusFact, { label: t('listen'), value: `${state.listen.host}:${String(state.listen.port)}` }),
            React.createElement(StatusFact, { label: t('upstream'), value: `${state.upstream.host}:${String(state.upstream.port)}` }),
            React.createElement(StatusFact, { label: t('sessions'), value: String(state.sessions) }),
            React.createElement(StatusFact, { label: t('uptime'), value: formatUptime(state.uptimeMs, t) }),
            React.createElement(StatusFact, { label: t('version'), value: state.version }),
            React.createElement(StatusFact, { label: t('dataDir'), value: state.dataDir })
          )
        ),
        error === '' ? null : React.createElement('p', { className: 'dshGatewayMessage dshGatewayError', role: 'alert' }, error),
        notice === '' ? null : React.createElement('p', { className: 'dshGatewayMessage dshGatewayNotice', role: 'status' }, notice)
        )
      )
    }

    const inject = ['slots', 'locale']
    const ROW_KEY = '@gitsang/dsh-gateway#gateway'

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'gateway: dictionaries'
      )
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
        {
          name: 'plugins.row.config',
          key: ROW_KEY,
          locale: NS
        },
        GatewayConfig
      ))
    }

    exports.apply = apply
    exports.inject = inject
    exports.__test = { formatUptime, GatewayConfig, ROW_KEY }
    return module.exports
  }
})
