import { chromium } from "playwright";
import { registerLiveSession, unregisterLiveSession } from "../jobSearchLiveSessionRegistry.js";

const DEFAULT_REMOTE_CDP_TIMEOUT_MS = 30000;

function clean(value) {
  return String(value || "").trim();
}

function remoteCdpEndpoint() {
  return clean(process.env.JOB_SEARCH_REMOTE_CDP_ENDPOINT)
    || clean(process.env.BROWSERLESS_CDP_ENDPOINT)
    || clean(process.env.BRIGHTDATA_BROWSER_CDP_ENDPOINT);
}

function remoteCdpTimeout() {
  const value = Number(process.env.JOB_SEARCH_REMOTE_CDP_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_REMOTE_CDP_TIMEOUT_MS;
}

async function newRemoteCdpPage(browser, options = {}) {
  const contextOptions = options && Object.keys(options).length > 0 ? options : null;

  if (contextOptions) {
    try {
      return await browser.newPage(contextOptions);
    } catch {
      // Some remote CDP providers expose only the default context. Fall back
      // to that shape so the adapters can still exercise the remote browser.
    }
  }

  const context = browser.contexts()[0] || await browser.newContext(contextOptions || undefined);
  return context.newPage();
}

async function registerPageForLiveRelay(sessionId, page) {
  const key = clean(sessionId);
  if (!key) return null;

  const cdpSession = await page.context().newCDPSession(page);
  const viewport = page.viewportSize() || { width: 1280, height: 800 };
  registerLiveSession(key, { page, cdpSession, viewport });

  let cleaned = false;
  return async () => {
    if (cleaned) return;
    cleaned = true;
    unregisterLiveSession(key);
    await cdpSession.detach().catch(() => {});
  };
}

function withLiveRelayPages(browser, createPage, sessionId) {
  const cleanups = new Set();
  const originalClose = browser.close.bind(browser);
  browser.close = async (...args) => {
    for (const cleanup of cleanups) {
      await cleanup().catch(() => {});
    }
    cleanups.clear();
    return originalClose(...args);
  };

  return async (options) => {
    const page = await createPage(options);
    const cleanup = await registerPageForLiveRelay(sessionId, page).catch((error) => {
      console.error(`[live-relay] Failed to register session "${sessionId}":`, error?.message || error);
      return null;
    });
    if (cleanup) {
      cleanups.add(cleanup);
      page.once("close", () => {
        cleanup().catch(() => {});
        cleanups.delete(cleanup);
      });
    }
    return page;
  };
}

export async function launchJobSearchBrowser({ headless = true, liveSessionId = "" } = {}) {
  const endpoint = remoteCdpEndpoint();
  if (!endpoint) {
    const browser = await chromium.launch({ headless });
    return {
      browser,
      provider: "local",
      newPage: withLiveRelayPages(browser, (options) => browser.newPage(options), liveSessionId),
      close: () => browser.close()
    };
  }

  const browser = await chromium.connectOverCDP(endpoint, { timeout: remoteCdpTimeout() });
  return {
    browser,
    provider: "remote-cdp",
    newPage: withLiveRelayPages(browser, (options) => newRemoteCdpPage(browser, options), liveSessionId),
    close: () => browser.close()
  };
}
