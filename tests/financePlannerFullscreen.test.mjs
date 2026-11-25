import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
const filename = fileURLToPath(new URL("../app/finance/usePlannerFullscreen.js", import.meta.url));
const { code } = transformSync(readFileSync(filename, "utf8"), {
  filename,
  jsc: { parser: { syntax: "ecmascript" }, target: "es2022" },
  module: { type: "commonjs" },
});
const settled = () => new Promise((resolve) => setImmediate(resolve));

function harness({ native, viewport = true } = {}) {
  const slots = [];
  let cursor = 0, effects = [], hook;
  const document = Object.assign(new EventTarget(), { documentElement: {}, fullscreenElement: null });
  const visualViewport = Object.assign(new EventTarget(), { height: 780, offsetTop: 0 });
  const window = Object.assign(new EventTarget(), { innerHeight: 800, visualViewport: viewport ? visualViewport : undefined });
  const counts = { enter: 0, exit: 0 };
  if (native) document.documentElement.requestFullscreen = () => {
    counts.enter++;
    return native({ document, enter() {
      document.fullscreenElement = document.documentElement;
      document.dispatchEvent(new Event("fullscreenchange"));
    } });
  };
  document.exitFullscreen = async () => {
    counts.exit++;
    document.fullscreenElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
  };
  const properties = new Map();
  const focusable = ({ hidden = false, disabled = false } = {}) => ({
    isConnected: true, disabled, tabIndex: 0,
    getClientRects: () => hidden ? [] : [{}],
    focus(options) { document.activeElement = this; this.focusOptions = options; },
  });
  const toggle = focusable(), close = focusable(), last = focusable();
  const controls = [close, focusable({ hidden: true }), focusable({ disabled: true }), last];
  const panel = { style: {
    setProperty: (name, value) => properties.set(name, value),
    removeProperty: (name) => properties.delete(name),
  }, querySelectorAll: () => controls };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies, cleanup: effect() };
        });
      }
    },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", "window", "document", code)(
    (specifier) => specifier === "react" ? react : require(specifier), module, module.exports, window, document,
  );
  function render() {
    cursor = 0; effects = [];
    hook = module.exports.default();
    hook.panelRef.current = panel; hook.toggleRef.current = toggle; hook.closeRef.current = close;
    effects.forEach((effect) => effect());
    return hook;
  }
  render();
  return { render, get hook() { return hook; }, document, window, visualViewport, properties, counts, toggle, close, last,
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}
const key = (name, extra = {}) => ({ key: name, preventDefault() { this.prevented = true; }, ...extra });

test("unsupported and rejected native fullscreen retain a working in-page view", async () => {
  for (const native of [undefined, async () => { throw new Error("Not supported"); }, () => { throw new Error("Denied"); }]) {
    const app = harness({ native });
    app.hook.enter();
    await settled();
    assert.equal(app.render().fullscreen, true);
    assert.equal(app.document.activeElement, app.close);
    const escape = key("Escape");
    app.hook.onKeyDown(escape);
    assert.equal(escape.prevented, true);
    assert.equal(app.render().fullscreen, false);
    assert.equal(app.document.activeElement, app.toggle);
    assert.deepEqual(app.toggle.focusOptions, { preventScroll: true });
    app.unmount();
  }
});

test("native fullscreen uses the document so transaction dialogs remain available and browser exit closes the view", async () => {
  const app = harness({ native: async ({ enter }) => enter() });
  app.hook.enter();
  await settled();
  assert.equal(app.render().fullscreen, true);
  assert.equal(app.document.fullscreenElement, app.document.documentElement);
  assert.equal(app.counts.enter, 1);
  await app.document.exitFullscreen();
  assert.equal(app.render().fullscreen, false);
  assert.equal(app.document.activeElement, app.toggle);
  app.unmount();
});

test("closing the expanded planner exits only native fullscreen it requested", async () => {
  const app = harness({ native: async ({ enter }) => enter() });
  app.hook.enter(); await settled(); app.render();
  app.hook.close(); app.render(); await settled();
  assert.equal(app.counts.exit, 1);
  assert.equal(app.document.fullscreenElement, null);
  app.unmount();
  const external = harness({ native: async ({ enter }) => enter() });
  external.document.fullscreenElement = external.document.documentElement;
  external.hook.enter(); external.render(); external.hook.close(); external.render();
  assert.equal(external.counts.enter, 0);
  assert.equal(external.counts.exit, 0, "closing cannot exit a different feature's fullscreen session");
  external.unmount();
});

test("the table follows keyboard and rotation viewport changes and removes its viewport listeners on close", () => {
  const app = harness();
  app.hook.enter(); app.render();
  assert.equal(app.properties.get("--fpt-viewport-height"), "780px");
  app.visualViewport.height = 410; app.visualViewport.offsetTop = 25;
  app.visualViewport.dispatchEvent(new Event("resize"));
  assert.equal(app.properties.get("--fpt-viewport-height"), "410px");
  assert.equal(app.properties.get("--fpt-viewport-top"), "25px");
  app.hook.close(); app.render();
  assert.equal(app.properties.size, 0);
  app.visualViewport.dispatchEvent(new Event("scroll"));
  app.window.dispatchEvent(new Event("resize"));
  assert.equal(app.properties.size, 0);
  app.unmount();
  const fallback = harness({ viewport: false });
  fallback.hook.enter(); fallback.render();
  fallback.window.innerHeight = 420; fallback.window.dispatchEvent(new Event("resize"));
  assert.equal(fallback.properties.get("--fpt-viewport-height"), "420px");
  fallback.unmount();
});

test("Tab stays within visible planner controls and handled Escape does not close the view", () => {
  const app = harness(); app.hook.enter(); app.render();
  app.last.focus();
  const tab = key("Tab"); app.hook.onKeyDown(tab);
  assert.equal(tab.prevented, true);
  assert.equal(app.document.activeElement, app.close);
  const reverse = key("Tab", { shiftKey: true }); app.hook.onKeyDown(reverse);
  assert.equal(reverse.prevented, true);
  assert.equal(app.document.activeElement, app.last);
  app.hook.onKeyDown(key("Escape", { defaultPrevented: true }));
  assert.equal(app.render().fullscreen, true);
  app.unmount();
});

test("closing or unmounting during a pending native request exits fullscreen when that request eventually resolves", async () => {
  for (const unmount of [false, true]) {
    let finish;
    const app = harness({ native: ({ enter }) => new Promise((resolve) => { finish = () => { enter(); resolve(); }; }) });
    app.hook.enter(); app.render();
    if (unmount) app.unmount();
    else { app.hook.close(); app.render(); }
    finish(); await settled();
    assert.equal(app.document.fullscreenElement, null);
    assert.equal(app.counts.exit, 1);
    if (!unmount) app.unmount();
  }
});
