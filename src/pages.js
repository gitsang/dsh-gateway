import { PWA_HEAD_TAGS } from './pwa.js'

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Read and URL-decode an HTML form body. Keeps an upper bound so a stray
 * client cannot make the proxy buffer an unbounded body.
 */
export function readFormBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let received = 0
    req.on('data', (chunk) => {
      received += chunk.length
      if (received > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

// Mirrors the dsh web design tokens (@deepseek-ai/dsh-client-ui-theme).
// The standalone gate page cannot read the web settings store, so it follows
// the system color scheme; that is also the web UI's default theme preference.
const LOGIN_THEME_CSS = `
  :root {
    color-scheme: light dark;
    --dsw-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
      'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
    --dsw-alias-bg-base: #ffffff;
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-border-l2: rgba(0, 0, 0, 0.10);
    --dsw-alias-brand-primary: #0f1115;
    --dsw-alias-label-primary: #0f1115;
    --dsw-alias-label-primary-foreground: #ffffff;
    --dsw-alias-label-secondary: #61666b;
    --dsw-alias-label-tertiary: #81858c;
    --dsw-alias-label-dimmed: #e1e5ee;
    --dsw-alias-button-primary-fill: #0f1115;
    --dsw-alias-button-primary-hover: #43454a;
    --dsw-alias-state-error-primary: #ec1313;
    --dsw-specific-login-input: #f9fafb;
    --dsw-shadow-lv3: 0 0 1px 0 rgba(0, 0, 0, 0.20), 0 0 4px 0 rgba(0, 0, 0, 0.02), 0 12px 32px 0 rgba(0, 0, 0, 0.08);
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --dsw-alias-bg-base: #151517;
      --dsw-alias-bg-layer-1: #232325;
      --dsw-alias-border-l2: rgba(255, 255, 255, 0.12);
      --dsw-alias-brand-primary: #f9fafb;
      --dsw-alias-label-primary: #f9fafb;
      --dsw-alias-label-primary-foreground: #0f1115;
      --dsw-alias-label-secondary: #cfd3d6;
      --dsw-alias-label-tertiary: #adb2b8;
      --dsw-alias-label-dimmed: #43454a;
      --dsw-alias-button-primary-fill: #f9fafb;
      --dsw-alias-button-primary-hover: #ebeef2;
      --dsw-alias-state-error-primary: #f25a5a;
      --dsw-specific-login-input: #1b1b1c;
    }
  }

  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    font-family: var(--dsw-font-family);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    background: var(--dsw-alias-bg-base);
    color: var(--dsw-alias-label-primary);
  }

  main {
    width: min(22rem, calc(100vw - 2rem));
    background: var(--dsw-alias-bg-layer-1);
    border: 1px solid var(--dsw-alias-border-l2);
    border-radius: 16px;
    padding: 2rem;
    box-shadow: var(--dsw-shadow-lv3);
  }

  h1 {
    margin: 0 0 0.5rem;
    font-size: 20px;
    line-height: 28px;
    font-weight: 500;
  }

  p.sub {
    margin: 0 0 1.5rem;
    color: var(--dsw-alias-label-tertiary);
    font-size: 14px;
    line-height: 22px;
  }

  label {
    display: block;
    margin: 0 0 0.375rem;
    font-size: 14px;
    line-height: 22px;
    color: var(--dsw-alias-label-secondary);
  }

  input {
    width: 100%;
    box-sizing: border-box;
    margin-bottom: 1rem;
    padding: 8px 12px;
    border: 1px solid var(--dsw-alias-border-l2);
    border-radius: 8px;
    background: var(--dsw-specific-login-input);
    color: var(--dsw-alias-label-primary);
    font: inherit;
    font-size: 14px;
    line-height: 22px;
  }

  input:focus {
    outline: none;
    border-color: var(--dsw-alias-brand-primary);
  }

  input::placeholder {
    color: var(--dsw-alias-label-dimmed);
  }

  button {
    width: 100%;
    height: 36px;
    border: 0;
    border-radius: 18px;
    background: var(--dsw-alias-button-primary-fill);
    color: var(--dsw-alias-label-primary-foreground);
    font: inherit;
    font-size: 14px;
    line-height: 22px;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    background: var(--dsw-alias-button-primary-hover);
  }

  .error {
    color: var(--dsw-alias-state-error-primary);
    font-size: 14px;
    line-height: 22px;
    margin: 0 0 1rem;
  }
`

/** Render the single setup/login page. */
export function renderLoginPage({ setup, error, next, pwa }) {
  const title = setup ? '设置密码' : '登录'
  const errorHtml = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : ''
  const confirmField = setup
    ? `
      <label for="confirm">确认密码</label>
      <input id="confirm" name="confirm" type="password" autocomplete="new-password" required>`
    : ''
  const submitLabel = setup ? '设置密码并进入' : '进入'
  const subtitle = setup
    ? '这是首次进入，请设置一个访问密码。'
    : '请输入访问密码。'

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · dsh web auth</title>
${pwa === false ? '' : PWA_HEAD_TAGS}
<style>${LOGIN_THEME_CSS}</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">${escapeHtml(subtitle)}</p>
  ${errorHtml}
  <form method="post" action="/login">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    ${confirmField}
    <button type="submit">${escapeHtml(submitLabel)}</button>
  </form>
</main>
</body>
</html>
`
}

/**
 * Only allow same-site redirect targets: a string starting with a single `/`
 * and not with `//` (which would be scheme-relative and therefore off-site).
 */
export function safeNext(next) {
  if (typeof next !== 'string' || next === '') return '/'
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  return next
}
