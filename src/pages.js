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
 * Read a request body as UTF-8. Keeps an upper bound so a stray client cannot
 * make the gateway buffer an unbounded body. Used for the gateway's own JSON
 * settings API; proxied traffic streams through untouched.
 */
export function readRequestBody(req, limit = 64 * 1024) {
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
// This standalone page cannot read the web settings store, so it follows the
// system color scheme; that is also the web UI's default theme preference.
const PAGE_THEME_CSS = `
  :root {
    color-scheme: light dark;
    --dsw-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
      'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
    --dsw-alias-bg-base: #ffffff;
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-border-l2: rgba(0, 0, 0, 0.10);
    --dsw-alias-brand-primary: #0f1115;
    --dsw-alias-label-primary: #0f1115;
    --dsw-alias-label-secondary: #61666b;
    --dsw-alias-label-tertiary: #81858c;
    --dsw-alias-label-dimmed: #e1e5ee;
    --dsw-shadow-lv3: 0 0 1px 0 rgba(0, 0, 0, 0.20), 0 0 4px 0 rgba(0, 0, 0, 0.02), 0 12px 32px 0 rgba(0, 0, 0, 0.08);
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --dsw-alias-bg-base: #151517;
      --dsw-alias-bg-layer-1: #232325;
      --dsw-alias-border-l2: rgba(255, 255, 255, 0.12);
      --dsw-alias-brand-primary: #f9fafb;
      --dsw-alias-label-primary: #f9fafb;
      --dsw-alias-label-secondary: #cfd3d6;
      --dsw-alias-label-tertiary: #adb2b8;
      --dsw-alias-label-dimmed: #43454a;
    }
  }

  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--dsw-alias-bg-base);
    color: var(--dsw-alias-label-primary);
    font-family: var(--dsw-font-family);
  }

  main {
    width: 100%;
    max-width: 380px;
    margin: 0 auto;
    padding: 32px;
    box-sizing: border-box;
    background: var(--dsw-alias-bg-layer-1);
    border: 0.5px solid var(--dsw-alias-border-l2);
    border-radius: 16px;
    box-shadow: var(--dsw-shadow-lv3);
  }

  h1 {
    margin: 0 0 8px;
    font-size: 20px;
    line-height: 28px;
    font-weight: 600;
  }

  p {
    margin: 0 0 12px;
    font-size: 14px;
    line-height: 22px;
    color: var(--dsw-alias-label-secondary);
  }

  p.hint {
    color: var(--dsw-alias-label-tertiary);
  }

  code {
    font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    font-size: 12px;
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--dsw-alias-bg-base);
    border: 0.5px solid var(--dsw-alias-border-l2);
  }
`

/**
 * Render the page shown when dsh rejects a browser that has no valid session.
 *
 * The gateway no longer authenticates anyone itself: authentication is dsh's
 * launch token exchanged for a signed cookie, and the only way to obtain it is
 * the URL printed by `dsh web` (or a `?token=` URL the gateway relays). This
 * page exists so a plain visit explains that instead of showing dsh's bare
 * one-line 401.
 */
export function renderUnauthorizedPage({ pwa }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>需要登录 · dsh gateway</title>
${pwa === false ? '' : PWA_HEAD_TAGS}
<style>${PAGE_THEME_CSS}</style>
</head>
<body>
<main>
  <h1>需要登录</h1>
  <p>网关已把请求转给 dsh，但 dsh 没有收到有效的登录凭据。</p>
  <p>请用 <code>dsh web</code> 启动时打印的链接打开本页，地址里带一个一次性的 <code>?token=</code> 参数。它会被换成 dsh 自己的签名 cookie，随后地址栏里的 token 会自动去掉。</p>
  <p class="hint">dsh 重启后 launch token 会变，旧 cookie 也会失效：重新打开一次新的启动链接即可。</p>
</main>
</body>
</html>
`
}
