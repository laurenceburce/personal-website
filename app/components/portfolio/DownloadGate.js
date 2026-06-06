"use client";

import { useEffect, useState } from "react";
import { getSession } from "next-auth/react";
import AuthProviderButtons from "../auth/AuthProviderButtons";
import { identifyAnalyticsVisitor } from "../../utils/analyticsClient";
import { IconDownload } from "./icons";
import { trackDownload } from "./navigationLinks";

const PENDING_DOWNLOAD_KEY = "portfolio-oauth-pending-download-v1";

export default function DownloadGate({ links }) {
  const [activeLink, setActiveLink] = useState(null);
  const [status, setStatus] = useState("");
  const [isChecking, setIsChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const completePendingDownload = async () => {
      const pendingLink = getPendingDownload();
      if (!pendingLink) return;

      const session = await getSession();
      if (cancelled || !session?.user?.email) return;

      clearPendingDownload();
      await identifyAnalyticsVisitor({
        email: session.user.email,
        name: session.user.name || ""
      });
      startDownload(pendingLink, session.user.email);
    };

    completePendingDownload();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleDownloadClick = async (link) => {
    if (isChecking) return;

    setIsChecking(true);
    setStatus("");

    try {
      const session = await getSession();
      if (session?.user?.email) {
        await identifyAnalyticsVisitor({
          email: session.user.email,
          name: session.user.name || ""
        });
        startDownload(link, session.user.email);
        return;
      }

      setActiveLink(link);
    } catch {
      setActiveLink(link);
      setStatus("Unable to check sign-in status.");
    } finally {
      setIsChecking(false);
    }
  };

  const handleSignInStart = () => {
    if (!activeLink || isChecking) return;

    setIsChecking(true);
    setStatus("Opening sign-in...");
    rememberPendingDownload(activeLink);
  };

  const handleClose = () => {
    if (isChecking) return;
    setActiveLink(null);
    setStatus("");
  };

  return (
    <>
      {links.map((link) => (
        <button
          key={link.href}
          type="button"
          className={`scroll-download-link scroll-download-${link.tone}`}
          aria-label={link.ariaLabel}
          onClick={() => handleDownloadClick(link)}
          disabled={isChecking}
        >
          <IconDownload />
          <span>{link.label}</span>
        </button>
      ))}

      {activeLink ? (
        <div className="download-gate" role="dialog" aria-modal="true" aria-labelledby="download-gate-title">
          <button
            className="download-gate-backdrop"
            type="button"
            aria-label="Close download dialog"
            onClick={handleClose}
          />
          <div className="download-gate-panel">
            <div className="download-gate-head">
              <p id="download-gate-title">Sign In to Download</p>
              <button type="button" onClick={handleClose} aria-label="Close download dialog">
                x
              </button>
            </div>
            <p className="download-gate-note">
              Required before downloading {activeLink.label.toLowerCase()}.
            </p>
            <AuthProviderButtons
              className="download-gate-providers"
              callbackUrl={typeof window !== "undefined" ? window.location.href : "/"}
              onBeforeSignIn={handleSignInStart}
              onSignInError={() => {
                clearPendingDownload();
                setIsChecking(false);
              }}
              onStatusChange={setStatus}
            />
            {status ? <p className="download-gate-status">{status}</p> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function startDownload(link, email) {
  trackDownload(link.label);
  const anchor = document.createElement("a");
  anchor.href = link.href;
  anchor.download = "";
  anchor.rel = "noopener";
  anchor.dataset.email = email;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function getPendingDownload() {
  try {
    const raw = window.sessionStorage.getItem(PENDING_DOWNLOAD_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function rememberPendingDownload(link) {
  try {
    window.sessionStorage.setItem(PENDING_DOWNLOAD_KEY, JSON.stringify({
      href: link.href,
      label: link.label,
      tone: link.tone
    }));
  } catch {}
}

function clearPendingDownload() {
  try {
    window.sessionStorage.removeItem(PENDING_DOWNLOAD_KEY);
  } catch {}
}
