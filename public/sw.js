self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Job Search's held-challenge push notifications (security code / anti-bot
// question / CAPTCHA — see app/lib/jobSearchHeldChallengeWatcher.js). Payload
// is always { title, body, url } JSON, sent from jobSearchPushSender.js.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || "Job Search";
  const url = payload.url || "/job-search";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      data: { url }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/job-search";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(url) && "focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
