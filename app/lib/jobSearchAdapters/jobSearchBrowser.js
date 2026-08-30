import { chromium } from "playwright";

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

export async function launchJobSearchBrowser({ headless = true } = {}) {
  const endpoint = remoteCdpEndpoint();
  if (!endpoint) {
    const browser = await chromium.launch({ headless });
    return {
      browser,
      provider: "local",
      newPage: (options) => browser.newPage(options),
      close: () => browser.close()
    };
  }

  const browser = await chromium.connectOverCDP(endpoint, { timeout: remoteCdpTimeout() });
  return {
    browser,
    provider: "remote-cdp",
    newPage: (options) => newRemoteCdpPage(browser, options),
    close: () => browser.close()
  };
}
