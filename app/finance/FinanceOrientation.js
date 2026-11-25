"use client";

import { useEffect } from "react";

export default function FinanceOrientation() {
  useEffect(() => {
    const appDisplay = window.matchMedia("(display-mode: standalone), (display-mode: fullscreen)");
    const allowRotation = async () => {
      if (document.visibilityState !== "visible" || (!appDisplay.matches && window.navigator.standalone !== true)) return;
      try {
        // Older installs can retain the original portrait-only manifest. An
        // explicit "any" overrides that default; unlock() would restore it.
        await window.screen.orientation?.lock?.("any");
      } catch {
        // Some platforms support rotation only through their app/OS settings.
      }
    };

    allowRotation();
    appDisplay.addEventListener("change", allowRotation);
    document.addEventListener("visibilitychange", allowRotation);
    document.addEventListener("fullscreenchange", allowRotation);
    window.addEventListener("pageshow", allowRotation);
    return () => {
      appDisplay.removeEventListener("change", allowRotation);
      document.removeEventListener("visibilitychange", allowRotation);
      document.removeEventListener("fullscreenchange", allowRotation);
      window.removeEventListener("pageshow", allowRotation);
    };
  }, []);

  return null;
}
