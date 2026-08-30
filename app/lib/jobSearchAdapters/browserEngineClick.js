const DEFAULT_CLICK_TIMEOUT_MS = 5000;

function cdpMouseEnabled() {
  return process.env.JOB_SEARCH_CDP_MOUSE_ENABLED !== "false";
}

async function dispatchCdpMouseClick(page, locator, { timeout = DEFAULT_CLICK_TIMEOUT_MS } = {}) {
  await locator.waitFor({ state: "visible", timeout });
  await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});

  const disabled = await locator
    .evaluate((el) => Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"))
    .catch(() => false);
  if (disabled) throw new Error("Target element is disabled.");

  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error("Target element has no clickable bounding box.");
  }

  // Playwright reports main-frame viewport coordinates even for locators
  // inside iframes, which is the coordinate space CDP expects here.
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const client = await page.context().newCDPSession(page);

  try {
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
      clickCount: 0
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await page.waitForTimeout(50).catch(() => {});
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
  } finally {
    await client.detach().catch(() => {});
  }
}

export async function clickWithBrowserMouse(page, locator, { timeout = DEFAULT_CLICK_TIMEOUT_MS } = {}) {
  if (!cdpMouseEnabled()) {
    await locator.click({ timeout });
    return "playwright";
  }

  try {
    await dispatchCdpMouseClick(page, locator, { timeout });
    return "cdp";
  } catch {
    await locator.click({ timeout });
    return "playwright";
  }
}
