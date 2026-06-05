"use client";

import { useState } from "react";
import { identifyAnalyticsVisitor } from "../../utils/analyticsClient";
import { IconDownload } from "./icons";
import { trackDownload } from "./navigationLinks";

const VERIFIED_EMAIL_KEY = "portfolio-download-verified-email-v1";

export default function DownloadGate({ links }) {
  const [activeLink, setActiveLink] = useState(null);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("");
  const [isChecking, setIsChecking] = useState(false);

  const handleDownloadClick = (link) => {
    const verifiedEmail = getVerifiedEmail();
    if (verifiedEmail) {
      startDownload(link, verifiedEmail);
      return;
    }

    setActiveLink(link);
    setEmail("");
    setStatus("");
  };

  const handleClose = () => {
    if (isChecking) return;
    setActiveLink(null);
    setStatus("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!activeLink || isChecking) return;

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setStatus("Enter your email address first.");
      return;
    }

    setIsChecking(true);
    setStatus("Checking deliverability...");

    try {
      const response = await fetch("/api/validate-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail })
      });
      const result = await response.json();

      if (!response.ok || !result.valid) {
        setStatus(result.message || "That email could not be verified.");
        return;
      }

      rememberVerifiedEmail(normalizedEmail);
      await identifyAnalyticsVisitor({ email: normalizedEmail });
      startDownload(activeLink, normalizedEmail);
      setActiveLink(null);
      setStatus("");
    } catch {
      setStatus("Email validation is temporarily unavailable.");
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
          <form className="download-gate-panel" onSubmit={handleSubmit}>
            <div className="download-gate-head">
              <p id="download-gate-title">Verify Email</p>
              <button type="button" onClick={handleClose} aria-label="Close download dialog">
                x
              </button>
            </div>
            <label>
              <span>Email address</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                disabled={isChecking}
                autoFocus
                required
              />
            </label>
            <p className="download-gate-note">
              Required before downloading {activeLink.label.toLowerCase()}.
            </p>
            {status ? <p className="download-gate-status">{status}</p> : null}
            <button className="download-gate-submit" type="submit" disabled={isChecking}>
              {isChecking ? "Checking..." : "Verify and Download"}
            </button>
          </form>
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

function getVerifiedEmail() {
  try {
    return window.localStorage.getItem(VERIFIED_EMAIL_KEY) || "";
  } catch {
    return "";
  }
}

function rememberVerifiedEmail(email) {
  try {
    window.localStorage.setItem(VERIFIED_EMAIL_KEY, email);
  } catch {}
}
