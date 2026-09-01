"use client";

import { useEffect, useState } from "react";

// VAPID public keys arrive from the server as URL-safe base64
// (JOB_SEARCH_VAPID_PUBLIC_KEY) — pushManager.subscribe() needs it as a raw
// Uint8Array instead.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

// Lets the held-submissions flow (see jobSearchHeldChallengeWatcher.js) reach
// the account owner even with the dashboard closed — a genuine OS push, not
// just the in-app toast (JobSearchAppClient's own SSE subscription), which
// only fires while a tab is open. Deliberately opt-in (a button, not an
// auto-prompt on page load) — the browser's own permission prompt is
// disruptive enough without triggering it on every visit.
export default function PushNotificationsControl() {
  const [status, setStatus] = useState("checking"); // checking | unsupported | off | on | busy
  const [error, setError] = useState("");

  useEffect(() => {
    async function checkStatus() {
      if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
        setStatus("unsupported");
        return;
      }
      try {
        const registration = await navigator.serviceWorker.getRegistration("/sw.js");
        const existing = await registration?.pushManager.getSubscription();
        setStatus(existing ? "on" : "off");
      } catch {
        setStatus("off");
      }
    }
    checkStatus();
  }, []);

  async function enable() {
    setStatus("busy");
    setError("");
    try {
      const keyResponse = await fetch("/api/job-search/push-subscriptions");
      const keyPayload = await keyResponse.json().catch(() => ({}));
      if (!keyPayload?.vapidPublicKey) throw new Error("Push notifications aren't configured on the server yet.");

      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted.");

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyPayload.vapidPublicKey)
      });

      await fetch("/api/job-search/push-subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "subscribe", data: subscription.toJSON() })
      });

      setStatus("on");
    } catch (err) {
      setError(err?.message || "Failed to enable notifications.");
      setStatus("off");
    }
  }

  async function disable() {
    setStatus("busy");
    setError("");
    try {
      const registration = await navigator.serviceWorker.getRegistration("/sw.js");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await fetch("/api/job-search/push-subscriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "unsubscribe", data: { endpoint: subscription.endpoint } })
        });
        await subscription.unsubscribe();
      }
      setStatus("off");
    } catch (err) {
      setError(err?.message || "Failed to disable notifications.");
      setStatus("on");
    }
  }

  if (status === "unsupported" || status === "checking") return null;

  return (
    <div className="job-search-push-control">
      <button type="button" disabled={status === "busy"} onClick={status === "on" ? disable : enable}>
        {status === "on" ? "Notifications On" : status === "busy" ? "Working..." : "Enable Notifications"}
      </button>
      {error ? <small className="job-search-alert-error">{error}</small> : null}
    </div>
  );
}
