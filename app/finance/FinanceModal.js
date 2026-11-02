"use client";

import { useEffect, useId, useRef } from "react";
import { isFinanceInputComposition } from "./FinanceNumberInput";

export default function FinanceModal({ title, children, onClose, busy }) {
  const dialog = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previous = window.document.activeElement;
    const element = dialog.current;
    if (!element.open) element.showModal();
    return () => {
      if (element.open) element.close();
      if (previous?.isConnected !== false) previous?.focus?.();
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
