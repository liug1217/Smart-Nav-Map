// 智行地圖的 service worker：只做推播通知(更新完成時後端推來的)，不快取網頁(網頁照常從 GitHub 抓最新的)
//   推播內容：{ title, body, url }；點通知 → 已經開著的智行地圖就切過去並重新整理，沒有就開新的
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

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
