import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
const filename = fileURLToPath(new URL("../app/finance/usePlannerZoom.js", import.meta.url));
const { code } = transformSync(readFileSync(filename, "utf8"), {
  filename, jsc: { parser: { syntax: "ecmascript" }, target: "es2022" }, module: { type: "commonjs" },
});
const STORAGE_KEY = "finance:planner:fullscreen-zoom:v1";

function scroller({ rowHeight = (scale) => 100 * scale, tableWidth = (scale) => 1600 * scale } = {}) {
  const node = Object.assign(new EventTarget(), {
    scrollTop: 400, scrollLeft: 80, clientWidth: 400, clientHeight: 300, scale: 1,
    getBoundingClientRect: () => ({ top: 100, left: 10, width: 400, height: 300 }),
  });
  const rows = Array.from({ length: 50 }, (_, index) => ({ isConnected: true,
    getBoundingClientRect() {
      const height = rowHeight(node.scale);
      const top = 100 + index * height - node.scrollTop;
      return { top, height, bottom: top + height };
    },
  }));
  node.querySelectorAll = () => rows;
  node.querySelector = () => ({ getBoundingClientRect: () => ({ width: tableWidth(node.scale) }) });
  return node;
}

function harness({ saved, storageUnavailable = false, fullscreen = false, node = scroller() } = {}) {
  const slots = [], writes = [];
  let cursor = 0, effects = [], hook;
  const scrollerRef = { current: node };
  const window = { localStorage: {
    getItem() { if (storageUnavailable) throw new Error("Denied"); return saved ?? null; },
    setItem(name, value) { if (storageUnavailable) throw new Error("Denied"); writes.push([name, value]); },
  } };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, effect, cleanup: effect() }; });
      }
    },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", "window", code)(
    (specifier) => specifier === "react" ? react : require(specifier), module, module.exports, window,
  );
  function render(next = {}) {
    if ("fullscreen" in next) fullscreen = next.fullscreen;
    if ("node" in next) scrollerRef.current = next.node;
    cursor = 0; effects = [];
    hook = module.exports.default({ fullscreen, scrollerRef });
    if (scrollerRef.current) scrollerRef.current.scale = fullscreen ? hook.zoom / 100 : 1;
    effects.forEach((effect) => effect());
    return hook;
  }
  const cleanup = () => slots.forEach((slot) => slot?.cleanup?.());
  render(); render();
  return { render, writes, get hook() { return hook; }, get node() { return scrollerRef.current; }, unmount: cleanup,
    replayEffects() { cleanup(); slots.forEach((slot) => { if (slot?.effect) slot.cleanup = slot.effect(); }); },
  };
}

function touch(node, type, points) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "touches", { value: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
  node.dispatchEvent(event);
  return event;
}

test("fullscreen starts at 75%, restores valid preferences without an initial write and leaves regular mode at 100%", () => {
  const app = harness();
  assert.equal(app.hook.zoom, 75);
  assert.equal(app.node.scale, 1);
  assert.deepEqual(app.writes, []);
  app.render({ fullscreen: true });
  assert.equal(app.node.scale, .75);
  app.hook.setZoom(115); app.render();
  assert.equal(app.hook.zoom, 115);
  assert.deepEqual(app.writes.at(-1), [STORAGE_KEY, "115"]);
  app.render({ fullscreen: false });
  assert.equal(app.node.scale, 1);
  assert.equal(app.hook.zoom, 115);
  app.unmount();
  const restored = harness({ saved: "92", fullscreen: true });
  assert.equal(restored.hook.zoom, 92);
  assert.deepEqual(restored.writes, []);
  restored.unmount();
});

test("malformed preferences and unavailable storage retain usable defaults, and zoom respects its supported range", () => {
  for (const saved of ["nope", "0", "205", "", "Infinity"]) {
    const app = harness({ saved }); assert.equal(app.hook.zoom, 75); app.unmount();
  }
  const app = harness({ storageUnavailable: true, fullscreen: true });
  app.hook.setZoom(500); app.render(); assert.equal(app.hook.zoom, 200);
  app.hook.setZoom(-5); app.render(); assert.equal(app.hook.zoom, 25);
  for (const invalid of [null, "", undefined, NaN]) { app.hook.setZoom(invalid); app.render(); assert.equal(app.hook.zoom, 25); }
  app.hook.resetZoom(); app.render(); assert.equal(app.hook.zoom, 75);
  app.unmount();
});

test("zoom preserves the row under the viewport center even when wrapping changes row height", () => {
  const node = scroller({ rowHeight: (scale) => scale < 1 ? 200 * scale : 100 * scale });
  const app = harness({ fullscreen: true, saved: "100", node });
  node.scrollTop = 500; node.scrollLeft = 100; node.dispatchEvent(new Event("scroll"));
  app.hook.setZoom(75); app.render();
  assert.equal(node.scrollTop, 825, "center remains halfway through the seventh row after its height changes");
  assert.equal(node.scrollLeft, 25);
  app.hook.setZoom(100); app.render();
  assert.equal(node.scrollTop, 500);
  assert.equal(node.scrollLeft, 100);
  app.unmount();
});

test("compact columns that keep their physical width do not drift horizontally when zoom changes", () => {
  const node = scroller({ tableWidth: () => 680 });
  const app = harness({ fullscreen: true, saved: "100", node });
  node.scrollLeft = 110;
  app.hook.setZoom(75); app.render();
  assert.equal(node.scrollLeft, 110);
  app.unmount();
});

test("two-finger gestures zoom the table around the fingers while one-finger scrolling stays native", () => {
  const app = harness({ fullscreen: true, saved: "100" });
  assert.equal(touch(app.node, "touchstart", [[100, 250]]).defaultPrevented, false);
  assert.equal(touch(app.node, "touchmove", [[100, 300]]).defaultPrevented, false);
  app.node.scrollTop = 500; app.node.scrollLeft = 100;
  assert.equal(touch(app.node, "touchstart", [[110, 250], [210, 250]]).defaultPrevented, true);
  assert.equal(touch(app.node, "touchmove", [[60, 250], [260, 250]]).defaultPrevented, true);
  app.render();
  assert.equal(app.hook.zoom, 200);
  assert.equal(app.node.scrollTop, 1150);
  assert.equal(app.node.scrollLeft, 350);
  touch(app.node, "touchend", [[60, 250]]);
  assert.equal(touch(app.node, "touchmove", [[60, 300]]).defaultPrevented, false);
  app.unmount();
});

test("pinch listeners follow newly loaded tables, stop outside fullscreen, and survive StrictMode effect replay", () => {
  const app = harness({ fullscreen: true, node: null });
  const first = scroller(); app.render({ node: first });
  app.replayEffects();
  assert.equal(touch(first, "touchstart", [[100, 250], [200, 250]]).defaultPrevented, true);
  touch(first, "touchmove", [[50, 250], [250, 250]]); app.render();
  assert.equal(app.hook.zoom, 150);
  const second = scroller(); app.render({ node: second });
  assert.equal(touch(first, "touchstart", [[100, 250], [200, 250]]).defaultPrevented, false);
  assert.equal(touch(second, "touchstart", [[100, 250], [200, 250]]).defaultPrevented, true);
  app.render({ fullscreen: false });
  assert.equal(touch(second, "touchmove", [[50, 250], [250, 250]]).defaultPrevented, false);
  app.render({ fullscreen: true });
  app.unmount();
  assert.equal(touch(second, "touchstart", [[100, 250], [200, 250]]).defaultPrevented, false);
});
