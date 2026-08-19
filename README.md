# dsh-web-auth

A lightweight password gate and reverse auth proxy in front of the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web UI.

The dsh web server itself is left untouched. This bundle adds one row to the
`web` profile: an auth proxy that starts beside `dsh web`, asks for a password
once on first use, and only then proxies requests through to the web server.

## How it works

- First visit: no password is stored yet, so `/login` shows the **set
  password** form.
- The password is hashed with **bcrypt** and written to
  `~/.dsh/profiles/web-auth/auth.json`.
- After setup (or on later visits), entering the password exchanges it for a
  random 256-bit session token. The token is stored server-side in
  `~/.dsh/profiles/web-auth/session.json` and delivered as a plain session
  cookie (`dsh_web_session`, no extra attributes by default).
- Every authenticated request refreshes that token's expiry by 24 hours
  (rolling expiry).
- Once authenticated, requests are proxied straight back to the dsh web server
  listening on its original port.
- By default the proxy also serves PWA assets (`/manifest.webmanifest`,
  `/sw.js`, `/icon-192.png`, `/icon-512.png`) and injects the manifest link
  plus a pass-through service-worker registration into HTML pages. This makes
  the proxy origin installable as a standalone web app on `localhost`/HTTPS.

A `~/.dsh/profiles/web-auth/.gitignore` is created on first run to keep
`auth.json` and `session.json` out of git.

## Install

Add the bundle to the existing `web` profile:

```bash
dsh plugin --profile web add github:gitsang/dsh-web-auth
```

Then start dsh web as usual:

```bash
dsh web
```

The dsh web server still listens on `127.0.0.1:3080`; the auth proxy listens
on `127.0.0.1:3081` by default. Open:

```bash
http://127.0.0.1:3081
```

## Configuration

All configuration is optional and read from environment variables at boot:

| Variable                | Default                    | Meaning                                               |
| ----------------------- | -------------------------- | ----------------------------------------------------- |
| `DSH_WEB_AUTH_HOST`     | `127.0.0.1`                | Auth proxy bind host                                  |
| `DSH_WEB_AUTH_PORT`     | `3081`                     | Auth proxy listen port                                |
| `DSH_WEB_AUTH_TTL_MS`   | `86400000`                 | Rolling session expiry (24h)                          |
| `DSH_WEB_AUTH_DATA_DIR` | `~/.dsh/profiles/web-auth` | Directory for `auth.json` and `session.json`          |
| `DSH_WEB_AUTH_PWA`      | `1`                        | Serve PWA assets and inject PWA tags into HTML        |
| `DSH_HOME`              | `~/.dsh`                   | dsh home (used when `DSH_WEB_AUTH_DATA_DIR` is unset) |

### PWA (installable web app)

PWA injection is enabled by default. The proxy serves the manifest, service
worker and icons itself, and injects the required tags into the login page and
proxied HTML responses. Set `DSH_WEB_AUTH_PWA=0` to disable it.

Browser install prompts require a secure context. `http://127.0.0.1:3081` and
`http://localhost:3081` qualify; an exposed `http://192.168.x.x:3081` LAN URL
does **not**. For LAN installability, terminate HTTPS in front of the proxy
with a certificate the browser trusts.

### Exposing through the auth proxy

The dsh web server itself is loopback-only (`--host 0.0.0.0` is rejected by
dsh web). To expose the UI on the LAN through this auth proxy, run:

```bash
DSH_WEB_AUTH_HOST=0.0.0.0 dsh web
```

The browser talks to the auth proxy with the proxy host in `Host`/`Origin`.
For non-loopback proxy hostnames/IPs, tell dsh web's API trust fence about the
same authority (the hostname or IP the browser uses, not the proxy port):

```bash
DSH_WEB_AUTH_HOST=0.0.0.0 dsh web --trusted-host 192.168.1.20
# or, if the browser reaches it through a name with a port:
DSH_WEB_AUTH_HOST=0.0.0.0 dsh web --trusted-host dsh-web.example.com:3081
```

`--trusted-host` is repeatable and is baked into the dsh web startup flags by
whatever process manager runs `dsh web`.

## Forgot password

Delete the stored hash file:

```bash
rm ~/.dsh/profiles/web-auth/auth.json
```

The next visit will show the setup form again. You may also want to clear the
session file:

```bash
rm ~/.dsh/profiles/web-auth/session.json
```

## Security notes

This is intentionally minimal: no rate limiting, no CSRF tokens, no
`HttpOnly`/`Secure`/`SameSite` cookie attributes, and sessions are stored as
plain text token→expiry entries. Use it as a lightweight gate for a trusted
local network, not as an internet-facing authentication layer.
