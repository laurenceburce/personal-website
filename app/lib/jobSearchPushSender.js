// Sends a real OS-level push notification, independent of whether the
// dashboard tab is open — called only from jobSearchHeldChallengeWatcher.js,
// which runs in the web app process (see that file's own header comment on
// why the submit-worker process never needs this or the VAPID private key).
import webpush from "web-push";
import { deletePushSubscriptionById, listPushSubscriptions } from "./jobSearchPushSubscriptionStore.js";

let vapidConfigured = false;

function configureVapid() {
  if (vapidConfigured) return true;
  const publicKey = process.env.JOB_SEARCH_VAPID_PUBLIC_KEY;
  const privateKey = process.env.JOB_SEARCH_VAPID_PRIVATE_KEY;
  const subject = process.env.JOB_SEARCH_VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return false;

  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

export function isPushConfigured() {
  return configureVapid();
}

// Best-effort, fire-and-forget from the caller's perspective — a push
// failure should never be why a held-challenge notification path throws.
// Sends to every subscribed browser/device in parallel; a 404/410 from a
// given push service means THAT subscription is gone for good (permission
// revoked, browser data cleared), so it's deleted rather than retried on the
// next challenge too.
export async function sendPushToAllSubscriptions(payload) {
  if (!configureVapid()) {
    console.warn("[push] JOB_SEARCH_VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT not set — skipping push notification.");
    return;
  }

  const subscriptions = await listPushSubscriptions().catch(() => []);
  if (subscriptions.length === 0) return;

  const body = JSON.stringify(payload);
  await Promise.all(subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body
      );
    } catch (error) {
      const statusCode = error?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await deletePushSubscriptionById(sub.id).catch(() => {});
      } else {
        console.error(`[push] Failed to send to subscription ${sub.id}:`, error?.message || error);
      }
    }
  }));
}
