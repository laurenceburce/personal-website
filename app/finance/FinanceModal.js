"use client";

import { useEffect, useId, useRef } from "react";
import { isFinanceInputComposition } from "./FinanceNumberInput";
import "./finance-modal.css";

export default function FinanceModal({ title, children, onClose, busy }) {
  const dialog = useRef(null);
  const titleId = useId();
  useEffect(() => {
    if (typeof window === "undefined") return;
    const browserWindow = window;
    const previous = browserWindow.document.activeElement;
    const element = dialog.current;
    if (!element) return;
    const body = browserWindow.document.body;
    const page = browserWindow.document.documentElement;
    const scrollX = browserWindow.scrollX || 0;
    const scrollY = browserWindow.scrollY || 0;
    const lockedProperties = ["position", "top", "left", "right", "width", "overflow"];
    const previousBodyStyle = body
      ? Object.fromEntries(lockedProperties.map((property) => [property, body.style[property]]))
      : null;
    // A fixed body also prevents background scrolling on iOS while the dialog
    // remains its own vertical scroll area. Keep the page's place for closing.
    if (body) {
      Object.assign(body.style, {
        position: "fixed",
        top: `${-scrollY}px`,
        left: `${-scrollX}px`,
        right: "0",
        width: "100%",
        overflow: "hidden",
      });
    }
    const viewport = browserWindow.visualViewport;
    const updateViewport = () => {
      const height = viewport?.height || browserWindow.innerHeight;
      if (Number.isFinite(height) && height > 0)
        element.style?.setProperty("--fp-dialog-viewport-height", `${height}px`);
      const top = viewport?.offsetTop || 0;
      element.style?.setProperty("--fp-dialog-viewport-top", `${top}px`);
    };
    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    browserWindow.addEventListener?.("resize", updateViewport);
    if (!element.open) element.showModal();
    return () => {
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      browserWindow.removeEventListener?.("resize", updateViewport);
      const previousScrollBehavior = page?.style.scrollBehavior;
      // The public site uses smooth scrolling; closing a dialog must restore
      // the frozen page immediately rather than animate from its temporary top.
      if (page) page.style.scrollBehavior = "auto";
      if (element.open) element.close();
      if (body) Object.assign(body.style, previousBodyStyle);
      if (previous?.isConnected !== false) previous?.focus?.({ preventScroll: true });
      browserWindow.scrollTo?.(scrollX, scrollY);
      if (page) page.style.scrollBehavior = previousScrollBehavior;
    };
  }, []);
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <dialog
      aria-labelledby={titleId}
      className="fp-modal"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        const target = event.target;
        if (
          event.key === "Enter" &&
          target?.tagName === "INPUT" &&
          [
            "text",
            "number",
            "email",
            "search",
            "url",
            "tel",
            "password",
          ].includes(target.type) &&
          !isFinanceInputComposition(event)
        )
          event.preventDefault();
      }}
    >
      <header>
        <div>
          <p className="fp-eyebrow">PERSONAL FINANCE</p>
          <h2 id={titleId}>{title}</h2>
        </div>
        <button
          type="button"
          className="fp-button fp-secondary fp-icon-button"
          aria-label="Close dialog"
          onClick={close}
          disabled={busy}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      </header>
      {children}
    </dialog>
  );
}
