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

/** Render the single setup/login page. */
export function renderLoginPage({ setup, error, next }) {
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
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #111;
    color: #eee;
  }
  main {
    width: min(22rem, calc(100vw - 2rem));
    background: #181818;
    border: 1px solid #2c2c2c;
    border-radius: 12px;
    padding: 2rem;
    box-shadow: 0 12px 40px rgba(0, 0, 0, .35);
  }
  h1 { margin: 0 0 .5rem; font-size: 1.25rem; }
  p.sub { margin: 0 0 1.5rem; color: #aaa; font-size: .875rem; }
  label { display: block; margin: 0 0 .375rem; font-size: .875rem; color: #ccc; }
  input {
    width: 100%;
    box-sizing: border-box;
    margin-bottom: 1rem;
    padding: .625rem .75rem;
    border: 1px solid #333;
    border-radius: 8px;
    background: #0f0f0f;
    color: #eee;
    font: inherit;
  }
  button {
    width: 100%;
    padding: .625rem .75rem;
    border: 0;
    border-radius: 8px;
    background: #4f8cff;
    color: white;
    font: inherit;
    cursor: pointer;
  }
  button:hover { background: #3d7bf0; }
  .error { color: #ff7b7b; font-size: .875rem; margin: 0 0 1rem; }
</style>
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
