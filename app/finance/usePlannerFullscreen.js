"use client";

import { useEffect, useRef, useState } from "react";

export default function usePlannerFullscreen() {
  const [fullscreen, setFullscreen] = useState(false);
  const panelRef = useRef(null);
  const toggleRef = useRef(null);
  const closeRef = useRef(null);
  const active = useRef(false);
  const nativeRequested = useRef(false);
  const nativeEntered = useRef(false);

  const exitNative = () => {
    if (document.fullscreenElement === document.documentElement && nativeRequested.current) {
      try { Promise.resolve(document.exitFullscreen()).catch(() => {}); }
      catch { /* The in-page view can close even if the browser already exited. */ }
    }
  };
  const close = () => {
    active.current = false;
    setFullscreen(false);
    exitNative();
  };
  const enter = () => {
    active.current = true;
    setFullscreen(true);
    // Keep the whole document available so transaction dialogs can still open.
    // iPhone and browsers that reject this retain the viewport-filling view.
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      nativeRequested.current = true;
      try {
        Promise.resolve(document.documentElement.requestFullscreen()).then(() => {
          nativeEntered.current = document.fullscreenElement === document.documentElement;
          if (!active.current) exitNative();
        }).catch(() => { nativeRequested.current = false; });
      } catch { nativeRequested.current = false; }
    }
  };

  useEffect(() => {
    const changed = () => {
      if (!nativeRequested.current) return;
      if (document.fullscreenElement === document.documentElement) nativeEntered.current = true;
      else if (nativeEntered.current) {
        nativeRequested.current = false;
        nativeEntered.current = false;
        active.current = false;
        setFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", changed);
    return () => {
      active.current = false;
      document.removeEventListener("fullscreenchange", changed);
      exitNative();
    };
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    const panel = panelRef.current;
    const viewport = window.visualViewport;
    const fit = () => {
      panel?.style.setProperty("--fpt-viewport-height", `${viewport?.height || window.innerHeight}px`);
      panel?.style.setProperty("--fpt-viewport-top", `${viewport?.offsetTop || 0}px`);
    };
    fit();
    viewport?.addEventListener("resize", fit);
    viewport?.addEventListener("scroll", fit);
    window.addEventListener("resize", fit);
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      viewport?.removeEventListener("resize", fit);
      viewport?.removeEventListener("scroll", fit);
      window.removeEventListener("resize", fit);
      panel?.style.removeProperty("--fpt-viewport-height");
      panel?.style.removeProperty("--fpt-viewport-top");
      if (toggleRef.current?.isConnected) toggleRef.current.focus({ preventScroll: true });
    };
  }, [fullscreen]);

  const onKeyDown = (event) => {
    if (!fullscreen || event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      const controls = [...panelRef.current.querySelectorAll("button, input, select, a[href], summary, [tabindex]")]
        .filter((element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }
  };

  return { fullscreen, panelRef, toggleRef, closeRef, enter, close, onKeyDown };
}
