"use client";

import { useEffect, useState } from "react";

export default function FinanceInstall() {
  const [installPrompt, setInstallPrompt] = useState(null);
  const [installed, setInstalled] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)");
    const updateInstalled = () => setInstalled(standalone.matches || window.navigator.standalone === true);
    const capturePrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const markInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
      setStatus("Finance is ready on your home screen.");
    };

    updateInstalled();
    standalone.addEventListener("change", updateInstalled);
    window.addEventListener("beforeinstallprompt", capturePrompt);
    window.addEventListener("appinstalled", markInstalled);

    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("/finance-sw.js", { scope: "/finance", updateViaCache: "none" }).catch(() => {
        // A browser shortcut still works when service workers are unavailable.
      });
    }

    return () => {
      standalone.removeEventListener("change", updateInstalled);
      window.removeEventListener("beforeinstallprompt", capturePrompt);
      window.removeEventListener("appinstalled", markInstalled);
    };
  }, []);

  async function install() {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      setStatus(choice.outcome === "accepted" ? "Follow your browser's prompt to finish installing." : "You can install Finance any time from your browser menu.");
    } catch {
      setStatus("Open your browser menu to add Finance to your home screen.");
    }
    setInstallPrompt(null);
  }

  return (
    <details className="fp-phone-card">
      <summary>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/></svg>
        <span>On your phone</span>
        <span aria-hidden="true">↗</span>
      </summary>
      <div className="fp-phone-content">
        {installed ? <p>Finance is running as an app.</p> : <p>Keep your planner a tap away.</p>}
        <p>Open your hosted finance URL on your phone and sign in with the same owner account. Changes sync after saving.</p>
        {!installed && installPrompt ? <button type="button" className="fp-button fp-button-primary" onClick={install}>Install app</button> : null}
        {!installed ? <ul>
          <li><strong>iPhone:</strong> In Safari, tap Share, then Add to Home Screen.</li>
          <li><strong>Android:</strong> In your browser menu, choose Install app or Add to Home screen.</li>
        </ul> : null}
        <small>Internet access is required to load and save your financial data.</small>
        <p className="fp-install-status" role="status">{status}</p>
      </div>
    </details>
  );
}
