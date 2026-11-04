// Retires the service worker the app used to install (it made the map installable on phones). A
// browser that still has it checks this address for updates, gets this version, and it deletes the
// caches, unregisters itself and reloads its pages so they run without it. Keep this file until
// visitors from before Nov 2026 have all been through.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) await caches.delete(name);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});
