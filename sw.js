// 智行地圖的 service worker：
//   1. 沒網路也能打開：
//      - 智行地圖.html：先上網抓最新的(4 秒內沒回應或沒網路就用存的)，一更新大家馬上看得到新版
//      - 安裝時讀一次網頁，網頁用到的檔案(自己的 js / 資料 / 圖片、地圖引擎 MapLibre 這些 CDN 套件)全部先存起來；
//        網頁改了版本號(?v=)也不用改這支，下次連網打開就會存新的
//      - 自己的檔案、CDN 套件：先用存的(秒開)，背景再更新
//      - 地圖底圖(OpenFreeMap 向量圖磚、字型、衛星圖)：看過的地方存起來(最多 3000 張)，沒網路時看過的地方還看得到
//      - 後端(路況、聊天、在線人數)、路線規劃、地址搜尋、監視器畫面：照常連網，不存
//   2. 推播通知(更新完成時後端推來的)：{ title, body, url }；點通知 → 切到 / 打開智行地圖
var VERSION = 'snm-offline-v1';
var APP_CACHE = VERSION + '-app';
var TILE_CACHE = 'snm-tiles-v1';
var TILE_LIMIT = 3000;
var PAGE = new URL('./智行地圖.html', self.location).href;
var CDN_HOSTS = ['unpkg.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];
var TILE_HOSTS = ['tiles.openfreemap.org', 'demotiles.maplibre.org', 'server.arcgisonline.com'];

function sameOrigin(url) { return url.origin === self.location.origin; }
function isCdn(url) { return CDN_HOSTS.indexOf(url.hostname) >= 0; }
function isTile(url) { return TILE_HOSTS.indexOf(url.hostname) >= 0; }

// 從網頁裡找出用到的檔案：src="…" / href="…"，還有 JS 字串裡的 '圖片/…'
function assetsInPage(html) {
  var found = {};
  var re = /(?:src|href)="([^"#]+)"/g, m;
  while ((m = re.exec(html))) found[m[1]] = 1;
  var img = /['"(](圖片\/[^'")\s]+)/g;
  while ((m = img.exec(html))) found[m[1]] = 1;
  return Object.keys(found).map(function (u) {
    if (/['+${}]/.test(u)) return null; // 程式組出來的網址，不是固定檔案
    try { return new URL(u, PAGE); } catch (_) { return null; }
  }).filter(function (u) {
    return u && (u.protocol === 'https:' || u.protocol === 'http:') && (sameOrigin(u) || isCdn(u)) && u.pathname.indexOf('/api/') < 0;
  }).map(function (u) { return u.href; });
}

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(APP_CACHE).then(function (cache) {
    return fetch(PAGE, { cache: 'reload' }).then(function (res) {
      if (!res.ok) throw new Error('page ' + res.status);
      return res.clone().text().then(function (html) {
        return cache.put(PAGE, res).then(function () {
          var list = assetsInPage(html).concat([new URL('./manifest.json', PAGE).href]);
          // 一個一個存：某個 CDN 檔案暫時抓不到，不要讓整個安裝失敗
          return Promise.all(list.map(function (url) {
            var req = new Request(url, { cache: 'reload', mode: sameOrigin(new URL(url)) ? 'same-origin' : 'cors', credentials: 'omit' });
            return fetch(req).then(function (r) { if (r.ok) return cache.put(url, r); }).catch(function () {});
          }));
        });
      });
    }).catch(function () {});
  }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  // 換版本時把舊的網頁快取清掉(地圖圖磚的快取保留)
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('snm-offline-') === 0 && k.indexOf(VERSION) !== 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function timeout(ms) { return new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, ms); }); }

// 網頁本身：先上網(最多 4 秒)，拿到就存起來；沒網路就用存的
function pageRequest(request) {
  return caches.open(APP_CACHE).then(function (cache) {
    return Promise.race([fetch(request), timeout(4000)]).then(function (res) {
      if (res.ok) cache.put(PAGE, res.clone());
      return res;
    }).catch(function () {
      return cache.match(PAGE).then(function (hit) { if (hit) return hit; throw new Error('offline'); });
    });
  });
}

// 先用存的，背景再更新；沒存過就上網抓並存起來。沒網路又找不到同版本時，退而求其次用不同版本號(?v=)的舊檔
function cachedFirst(e, cacheName, after) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(e.request).then(function (hit) {
      var update = fetch(e.request).then(function (res) {
        if (res.ok || res.type === 'opaque') {
          cache.put(e.request, res.clone());
          if (after) after(cache);
        }
        return res;
      }).catch(function () { return null; });
      if (hit) { e.waitUntil(update); return hit; }
      return update.then(function (res) {
        if (res) return res;
        return cache.match(e.request, { ignoreSearch: true }).then(function (old) { return old || Response.error(); });
      });
    });
  });
}

// 圖磚最多留 TILE_LIMIT 張：存了一陣子檢查一次，多的從最舊的刪
var tilePuts = 0;
function trimTiles(cache) {
  if (++tilePuts % 50) return;
  cache.keys().then(function (keys) {
    var extra = keys.length - TILE_LIMIT;
    for (var i = 0; i < extra; i++) cache.delete(keys[i]);
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  var url = new URL(req.url);
  if (sameOrigin(url)) {
    if (url.pathname.indexOf('/api/') >= 0) return;
    if (req.mode === 'navigate' || /\.html$/.test(decodeURIComponent(url.pathname))) { e.respondWith(pageRequest(req)); return; }
    e.respondWith(cachedFirst(e, APP_CACHE));
    return;
  }
  if (isCdn(url)) { e.respondWith(cachedFirst(e, APP_CACHE)); return; }
  if (isTile(url)) { e.respondWith(cachedFirst(e, TILE_CACHE, trimTiles)); return; }
  // 其他(後端、路線、搜尋、監視器)照常連網
});

// ---------- 推播通知 ----------
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || '智行地圖', {
    body: d.body || '',
    icon: '圖片/智行地圖.png',
    badge: '圖片/智行地圖.png',
    tag: 'snm-update',          // 同一種通知只留最新一則
    renotify: true,
    data: { url: d.url || './智行地圖.html' }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || './智行地圖.html';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (/智行地圖|%E6%99%BA%E8%A1%8C/.test(list[i].url) && 'focus' in list[i]) { list[i].navigate(list[i].url); return list[i].focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
