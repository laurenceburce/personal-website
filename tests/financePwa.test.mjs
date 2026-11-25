import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
function compile(file) {
  const filename = fileURLToPath(new URL(file, import.meta.url));
  return transformSync(readFileSync(filename, "utf8"), {
    filename,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
    module: { type: "commonjs" },
  }).code;
}
const orientationCode = compile("../app/finance/FinanceOrientation.js");
function harness({ installed = true, appleInstalled = false, lock } = {}) {
  const calls = [];
  const media = Object.assign(new EventTarget(), { matches: installed });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const window = Object.assign(new EventTarget(), {
    matchMedia: () => media,
    navigator: { standalone: appleInstalled },
    screen: { orientation: { lock: lock ?? (async (value) => { calls.push(value); }) } },
  });
  let cleanup;
  const module = { exports: {} };
  new Function("require", "module", "exports", "window", "document", orientationCode)(
    (specifier) => specifier === "react" ? { useEffect(effect) { cleanup = effect(); } } : require(specifier),
    module, module.exports, window, document,
  );
  module.exports.default();
  return { window, document, media, calls, unmount: () => cleanup() };
}

test("installed apps override a retained portrait default and restore rotation when resumed", () => {
  const app = harness();
  assert.deepEqual(app.calls, ["any"]);
  app.document.visibilityState = "hidden";
  app.document.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(app.calls, ["any"]);
  app.document.visibilityState = "visible";
  app.document.dispatchEvent(new Event("visibilitychange"));
  app.document.dispatchEvent(new Event("fullscreenchange"));
  app.window.dispatchEvent(new Event("pageshow"));
  assert.deepEqual(app.calls, ["any", "any", "any", "any"]);
  app.unmount();
  app.document.dispatchEvent(new Event("visibilitychange"));
  app.document.dispatchEvent(new Event("fullscreenchange"));
  app.window.dispatchEvent(new Event("pageshow"));
  app.media.dispatchEvent(new Event("change"));
  assert.equal(app.calls.length, 4);
});

test("regular browser tabs keep their native rotation behavior", () => {
  const app = harness({ installed: false });
  app.document.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(app.calls, []);
  app.media.matches = true;
  app.media.dispatchEvent(new Event("change"));
  assert.deepEqual(app.calls, ["any"]);
  app.unmount();
});

test("Apple's standalone flag is detected and unavailable orientation APIs are tolerated", async () => {
  const apple = harness({ installed: false, appleInstalled: true });
  assert.deepEqual(apple.calls, ["any"]);
  apple.unmount();
  const unsupported = harness({ lock: async () => { throw new Error("Not supported"); } });
  await new Promise((resolve) => setImmediate(resolve));
  unsupported.window.screen.orientation = undefined;
  unsupported.window.dispatchEvent(new Event("pageshow"));
  await new Promise((resolve) => setImmediate(resolve));
  unsupported.unmount();
});

test("finance layout supplies the same install metadata to sign-in and the planner", () => {
  const module = { exports: {} };
  new Function("require", "module", "exports", compile("../app/finance/layout.js"))(
    (specifier) => specifier === "./FinanceOrientation" ? { default: () => null } : require(specifier),
    module, module.exports,
  );
  assert.equal(module.exports.metadata.manifest, "/finance/manifest.webmanifest");
  assert.equal(module.exports.metadata.appleWebApp.capable, true);
  assert.equal(module.exports.viewport.viewportFit, "cover");
});

test("both install manifests permit portrait and landscape", async () => {
  const root = { exports: {} };
  new Function("module", "exports", compile("../app/manifest.js"))(root, root.exports);
  assert.equal(root.exports.default().orientation, "any");
  const finance = { exports: {} };
  new Function("module", "exports", compile("../app/finance/manifest.webmanifest/route.js"))(finance, finance.exports);
  assert.equal((await finance.exports.GET().json()).orientation, "any");
});
