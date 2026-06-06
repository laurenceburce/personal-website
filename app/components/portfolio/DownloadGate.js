"use client";

import { useEffect, useState } from "react";
import { getSession } from "next-auth/react";
import { identifyAnalyticsVisitor } from "../../utils/analyticsClient";
import { IconDownload } from "./icons";
import { trackDownload } from "./navigationLinks";
import { openAuthModal } from "../../utils/authModal";

const PENDING_DOWNLOAD_KEY = "portfolio-oauth-pending-download-v1";

export default function DownloadGate({ links }) {
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
        name: session.user.name || "",
        authProvider: session.user.provider || "",
        profileImage: session.user.image || ""
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

    try {
      const session = await getSession();
      if (session?.user?.email) {
        await identifyAnalyticsVisitor({
          email: session.user.email,
          name: session.user.name || "",
          authProvider: session.user.provider || "",
          profileImage: session.user.image || ""
        });
        startDownload(link, session.user.email);
        return;
      }

      rememberPendingDownload(link);
      openAuthModal({
        title: "Sign In to Download",
        message: `Required before downloading ${link.label.toLowerCase()}.`
      });
    } catch {
      rememberPendingDownload(link);
      openAuthModal({
        title: "Sign In to Download",
        message: `Required before downloading ${link.label.toLowerCase()}.`
      });
    } finally {
      setIsChecking(false);
    }
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
