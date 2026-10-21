/**
 * PWA assets served by the dsh-gateway proxy.
 *
 * The browser talks to this proxy as the origin, so the manifest, service
 * worker and icons must be served from these paths on the proxy itself, not
 * from the upstream dsh web server.
 */

export const MANIFEST = {
  name: 'dsh web',
  short_name: 'dsh',
  description: 'dsh web UI through dsh-gateway',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#0f1115',
  icons: [
    { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }
  ]
}

/**
 * The PWA service worker: a network-first shell plus a cache-first store for
 * immutable assets. It never caches API traffic, login pages, auth redirects
 * or responses marked `no-store`. WebSocket upgrades are never seen by a
 * service worker, so the proxy upgrade path is unaffected.
 */
export const SW_JS = `
const CACHE_PREFIX = 'dsh-gateway-';
const SHELL_CACHE = 'dsh-gateway-shell-v1';
const ASSET_CACHE = 'dsh-gateway-assets-v1';
const NAVIGATION_TIMEOUT_MS = 3000;
const MAX_ASSET_ENTRIES = 300;
const PRECACHE = ['/manifest.webmanifest', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => (name.startsWith(CACHE_PREFIX) || name.startsWith('dsh-web-auth-')) &&
        name !== SHELL_CACHE && name !== ASSET_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

function isAssetRequest(url) {
  if (url.pathname.startsWith('/assets/')) return true;
  return url.pathname.startsWith('/plugins/') && /[?&]rev=/.test(url.search);
}

function isRefreshableAsset(url) {
  return url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/favicon.svg' ||
    url.pathname === '/favicon-dark.svg';
}

function canStore(response) {
  if (!response || !response.ok) return false;
  if (response.redirected) return false;
  if (response.type !== 'basic') return false;
  return !/no-store/i.test(response.headers.get('cache-control') || '');
}

function canStoreDocument(response) {
  if (!canStore(response)) return false;
  return (response.headers.get('content-type') || '').indexOf('text/html') !== -1;
}

async function trimAssetCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - MAX_ASSET_ENTRIES;
  if (excess <= 0) return;
  await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached !== undefined) return cached;
  const response = await fetch(request);
  if (canStore(response)) {
    try {
      await cache.put(request, response.clone());
      await trimAssetCache(cache);
    } catch (error) {
      // A full or evicted cache must never break the page load.
    }
  }
  return response;
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then(async (response) => {
    if (canStore(response)) {
      try { await cache.put(request, response.clone()); } catch (error) {}
    }
    return response;
  });
  if (cached !== undefined) {
    event.waitUntil(network.catch(() => undefined));
    return cached;
  }
  return network;
}

async function networkFirstNavigation(event, request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then(async (response) => {
    if (canStoreDocument(response)) {
      try { await cache.put(request, response.clone()); } catch (error) {}
    }
    return response;
  });
  if (cached === undefined) return network;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      event.waitUntil(network.catch(() => undefined));
      resolve(cached);
    }, NAVIGATION_TIMEOUT_MS);
    network.then((response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(cached);
    });
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.headers.has('range')) return;
  if (url.pathname === '/sw.js' || url.pathname === '/login' || url.pathname === '/logout' || url.pathname === '/connect') return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event, request));
    return;
  }
  if (isAssetRequest(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (isRefreshableAsset(url)) {
    event.respondWith(staleWhileRevalidate(event, request));
  }
});
`

/**
 * Served from /sw.js after PWA support is switched off. An already-installed
 * worker updates itself into this version, drops the gateway caches and
 * unregisters, so disabling PWA does not leave an old offline shell behind.
 */
export const SW_DISABLED_JS = `
const CACHE_PREFIX = 'dsh-gateway-';
const LEGACY_PREFIX = 'dsh-web-auth-';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) || name.startsWith(LEGACY_PREFIX))
      .map((name) => caches.delete(name)));
    await self.registration.unregister();
  })());
});
`

/**
 * The DeepSeek whale mark, identical to the dsh web frontend favicon.svg.
 * Served at /favicon.svg so the manifest and the browser tab can share the
 * same SVG.
 */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="50.000000" height="50.000000" viewBox="0 0 50 50" fill="none">
	<style>
		@media (prefers-color-scheme: dark) {
			path { fill: #fff; }
		}
	</style>
	<path id="path" d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z" fill="#000" fill-opacity="1.000000" fill-rule="nonzero"/>
</svg>`

/**
 * Injected into the head of the login page and proxied text/html responses.
 * The comment is an idempotency marker for injectPwaTags().
 */
export const PWA_HEAD_TAGS = `
<!-- dsh-gateway-pwa -->
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="theme-color" content="#0f1115">
<script>
  if (window.location.pathname === '/login' && 'caches' in window) {
    caches.has('dsh-gateway-shell-v1').then(function (exists) {
      if (!exists) return;
      return caches.open('dsh-gateway-shell-v1').then(function (cache) {
        return cache.keys().then(function (keys) {
          return Promise.all(keys.filter(function (key) {
            return key.destination === 'document' || new URL(key.url).pathname === '/';
          }).map(function (key) { return cache.delete(key); }));
        });
      });
    }).catch(function () {});
  }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(function () {});
    });
  }
</script>`

/** Inject PWA tags right after the opening <head...> tag, at most once. */
export function injectPwaTags(html) {
  if (typeof html !== 'string' || html === '') return html
  if (html.includes('dsh-gateway-pwa')) return html
  const match = /<head([^>]*)>/i.exec(html)
  if (!match) return html
  return html.replace(match[0], () => `<head${match[1]}>${PWA_HEAD_TAGS}`)
}

/**
 * The marker comment makes {@link injectHostModeTag} idempotent.
 *
 * Why: dsh decides whether the page may read and write Host settings from
 * `ctx.remote.$host.isLoopback`, which is
 * `transport?.ownsHost === true || no location || loopback hostname`. A page
 * served through this proxy is never on a loopback hostname, so without this
 * tag Settings starts in `memory` mode and the Models page reports
 * "settings are unavailable in this browser". Declaring the same transport
 * flag the Desktop shell uses restores Host mode.
 */
export const HOST_MODE_HEAD_TAG = `
<!-- dsh-gateway-host-mode -->
<script>globalThis.__DSH_TRANSPORT__={...(globalThis.__DSH_TRANSPORT__||{}),ownsHost:true}</script>`

/** Inject the Host-mode transport flag right after the opening <head...> tag, at most once. */
export function injectHostModeTag(html) {
  if (typeof html !== 'string' || html === '') return html
  if (html.includes('dsh-gateway-host-mode')) return html
  const match = /<head([^>]*)>/i.exec(html)
  if (!match) return html
  return html.replace(match[0], () => `<head${match[1]}>${HOST_MODE_HEAD_TAG}`)
}
