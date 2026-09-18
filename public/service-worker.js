self.addEventListener('install', event => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // لا نخزن بيانات الـ API حتى تبقى البيانات محدثة
    if (url.pathname.startsWith('/api/')) return;

    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});
