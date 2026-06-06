const _callbacks = new Map();
let _callbackId = 0;

export function openAuthModal({ title, message, onBeforeSignIn } = {}) {
  if (typeof window === "undefined") return;

  let callbackId = null;
  if (typeof onBeforeSignIn === "function") {
    callbackId = ++_callbackId;
    _callbacks.set(callbackId, onBeforeSignIn);
  }

  window.dispatchEvent(
    new CustomEvent("open-auth-modal", {
      detail: { title, message, callbackId }
    })
  );
}

export function consumeAuthModalCallback(callbackId) {
  if (!callbackId) return null;
  const cb = _callbacks.get(callbackId) ?? null;
  _callbacks.delete(callbackId);
  return cb;
}
