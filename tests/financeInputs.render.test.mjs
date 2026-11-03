import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
const codes = new Map();
for (const file of ["FinanceNumberInput", "FinanceModal"]) {
  const url = new URL(`../app/finance/${file}.js`, import.meta.url);
  codes.set(
    file,
    transformSync(await readFile(url, "utf8"), {
      filename: fileURLToPath(url),
      jsc: {
        parser: { syntax: "ecmascript", jsx: true },
        transform: { react: { runtime: "automatic" } },
        target: "es2022",
      },
      module: { type: "commonjs" },
    }).code,
  );
}

function harness() {
  const slots = [];
  const pending = [];
  let cursor = 0;
  const react = {
    useRef(initial) {
      const index = cursor++;
      return (slots[index] ??= { current: initial });
    },
    useId() {
      return `finance-dialog-${cursor++}`;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (
        !previous ||
        deps.length !== previous.deps.length ||
        deps.some((value, item) => !Object.is(value, previous.deps[item]))
      ) {
        pending.push(() => {
          previous?.cleanup?.();
          slots[index] = { deps, cleanup: effect() };
        });
      }
    },
  };
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    new Function("require", "module", "exports", codes.get(file))(
      (specifier) => {
        if (specifier === "react") return react;
        if (specifier.endsWith(".css")) return {};
        if (specifier === "./FinanceNumberInput")
          return load("FinanceNumberInput");
        return require(specifier);
      },
      module,
      module.exports,
    );
    cache.set(file, module.exports);
    return module.exports;
  };
  return {
    load,
    render(file, props) {
      cursor = 0;
      return load(file).default(props);
    },
    flushEffects() {
      while (pending.length) pending.shift()();
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}

function inputElement(value = "") {
  return {
    value,
    selectionStart: 0,
    selectionEnd: value.length,
    validationMessage: "",
    setCustomValidity(message) {
      this.validationMessage = message;
    },
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.selectionStart = this.selectionEnd = start + text.length;
    },
  };
}

function keyboardEvent(target, extra = {}) {
  return {
    key: "Enter",
    target,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...extra,
  };
}

test("money inputs keep incomplete edits, decimal zeros, and deletion without coercion", () => {
  const hooks = harness();
  const element = inputElement();
  let draft = "";
  const render = () => {
    const tree = hooks.render("FinanceNumberInput", {
      value: draft,
      min: "-999999999",
      max: "999999999",
      required: true,
      onChange(event) {
        draft = event.target.value;
      },
    });
    tree.props.ref(element);
    hooks.flushEffects();
    return tree;
  };
  let tree = render();
  assert.equal(tree.props.type, "text");
  assert.equal(tree.props.inputMode, "decimal");
  assert.match(element.validationMessage, /Enter a value/);
  for (const raw of [
    "-",
    "-1",
    "",
    "0",
    "0.",
    "0.5",
    "12.30",
    "1234.56",
    "",
    ".",
    ".25",
  ]) {
    element.value = raw;
    tree.props.onChange({ target: element, currentTarget: element });
    tree = render();
    assert.equal(tree.props.value, raw);
    assert.equal(element.value, raw);
    if (raw === "1234.56") assert.equal(element.validationMessage, "");
  }
  assert.equal(element.validationMessage, "");
});

test("invalid ranges, cents, and whole days remain editable and recover after correction", () => {
  const hooks = harness();
  const element = inputElement();
  const render = (value, extra = {}) => {
    element.value = value;
    const tree = hooks.render("FinanceNumberInput", {
      value,
      min: "0.01",
      max: "100",
      step: "0.01",
      ...extra,
    });
    tree.props.ref(element);
    hooks.flushEffects();
    return tree;
  };
  for (const [value, error] of [
    ["-", /valid number/],
    ["0", /at least/],
    ["101", /no greater/],
    ["12.345", /2 decimal places/],
  ]) {
    assert.equal(render(value).props.value, value);
    assert.match(element.validationMessage, error);
  }
  render("12.30");
  assert.equal(element.validationMessage, "");
  const day = render("1.5", { min: "1", max: "31", step: "1" });
  assert.equal(day.props.inputMode, "numeric");
  assert.match(element.validationMessage, /whole number/);
  render("31", { min: "1", max: "31", step: "1" });
  assert.equal(element.validationMessage, "");
  render("invalid", { disabled: true });
  assert.equal(element.validationMessage, "");
});

test("safe currency paste replaces only the selection and informs the controlled draft", () => {
  const hooks = harness();
  const element = inputElement("900.00");
  let changed;
  const tree = hooks.render("FinanceNumberInput", {
    value: element.value,
    onChange: (event) => {
      changed = event.target.value;
    },
  });
  const event = {
    target: element,
    currentTarget: element,
    clipboardData: { getData: () => " ₱1,234.50 " },
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  tree.props.onPaste(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(element.value, "1234.50");
  assert.equal(changed, "1234.50");
  assert.equal(element.validationMessage, "");
  assert.equal(element.selectionStart, "1234.50".length);
  const normalize =
    hooks.load("FinanceNumberInput").normalizeFinanceNumberPaste;
  assert.equal(normalize("-$1,234.56"), "-1234.56");
  assert.equal(normalize("1,23.45"), null);
  assert.equal(normalize("USD 12 and 34"), null);
});

test("number Enter avoids implicit saves while composition and external key handlers survive", () => {
  const hooks = harness();
  let calls = 0;
  const tree = hooks.render("FinanceNumberInput", {
    value: "12.30",
    onKeyDown() {
      calls++;
    },
  });
  const normal = keyboardEvent({ tagName: "INPUT", type: "text" });
  tree.props.onKeyDown(normal);
  assert.equal(normal.defaultPrevented, true);
  const composition = keyboardEvent(normal.target, {
    nativeEvent: { isComposing: true },
  });
  tree.props.onKeyDown(composition);
  assert.equal(composition.defaultPrevented, false);
  const legacyComposition = keyboardEvent(normal.target, { keyCode: 229 });
  tree.props.onKeyDown(legacyComposition);
  assert.equal(legacyComposition.defaultPrevented, false);
  assert.equal(calls, 3);
});

test("finance dialog stays open through backdrop and text-selection gestures", () => {
  const hooks = harness();
  let closes = 0;
  const tree = hooks.render("FinanceModal", {
    title: "Edit bill",
    children: "Draft",
    onClose: () => closes++,
  });
  // Native dialog backdrop events have no dismissal handler. A drag ending on
  // the dialog cannot throw away the form, and clicks inside stay harmless.
  assert.equal(tree.type, "dialog");
  assert.equal(tree.props.onClick, undefined);
  assert.equal(tree.props.onPointerUp, undefined);
  assert.equal(closes, 0);
  const closeButton = tree.props.children[0].props.children[1];
  assert.equal(closeButton.props.type, "button");
  closeButton.props.onClick();
  assert.equal(closes, 1);
  const escape = keyboardEvent();
  tree.props.onCancel(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(closes, 2);
});

test("dialog blocks text-field Enter but preserves Save, textarea, select, and composition", () => {
  const hooks = harness();
  const tree = hooks.render("FinanceModal", {
    title: "New transaction",
    onClose() {},
  });
  const input = keyboardEvent({ tagName: "INPUT", type: "text" });
  tree.props.onKeyDown(input);
  assert.equal(input.defaultPrevented, true);
  for (const target of [
    { tagName: "BUTTON", type: "submit" },
    { tagName: "INPUT", type: "submit" },
    { tagName: "TEXTAREA" },
    { tagName: "SELECT" },
  ]) {
    const event = keyboardEvent(target);
    tree.props.onKeyDown(event);
    assert.equal(event.defaultPrevented, false);
  }
  const composing = keyboardEvent(input.target, { isComposing: true });
  tree.props.onKeyDown(composing);
  assert.equal(composing.defaultPrevented, false);
});

test("busy dialog refuses dismissals and mounts once without resetting focus on rerenders", () => {
  const previousWindow = globalThis.window;
  const hooks = harness();
  let closes = 0;
  let opens = 0;
  let nativeCloses = 0;
  let restores = 0;
  const element = {
    open: false,
    showModal() {
      this.open = true;
      opens++;
    },
    close() {
      this.open = false;
      nativeCloses++;
    },
  };
  globalThis.window = {
    document: { activeElement: { focus: () => restores++ } },
  };
  try {
    const props = { title: "Edit", busy: true, onClose: () => closes++ };
    let tree = hooks.render("FinanceModal", props);
    tree.props.ref.current = element;
    hooks.flushEffects();
    tree = hooks.render("FinanceModal", { ...props, title: "Edit again" });
    hooks.flushEffects();
    tree.props.onCancel({ preventDefault() {} });
    tree.props.children[0].props.children[1].props.onClick();
    assert.equal(closes, 0);
    assert.equal(opens, 1);
    assert.equal(restores, 0);
    hooks.unmount();
    assert.equal(nativeCloses, 1);
    assert.equal(restores, 1);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("phone dialog locks the background, follows the keyboard viewport, and restores its place", () => {
  const previousWindow = globalThis.window;
  const hooks = harness();
  const originalStyle = {
    position: "relative",
    top: "3px",
    left: "0px",
    right: "auto",
    width: "90%",
    overflow: "auto",
  };
  const body = { style: { ...originalStyle } };
  const page = { style: { scrollBehavior: "smooth" } };
  const viewportListeners = new Map();
  const windowListeners = new Map();
  const viewport = {
    height: 740,
    offsetTop: 0,
    addEventListener(type, callback) {
      viewportListeners.set(type, callback);
    },
    removeEventListener(type, callback) {
      assert.equal(viewportListeners.get(type), callback);
      viewportListeners.delete(type);
    },
  };
  const variables = new Map();
  const element = {
    open: false,
    style: { setProperty: (name, value) => variables.set(name, value) },
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
  let restoredFocus, restoredScroll;
  globalThis.window = {
    scrollX: 12,
    scrollY: 640,
    innerHeight: 800,
    visualViewport: viewport,
    document: {
      body,
      documentElement: page,
      activeElement: { isConnected: true, focus: (options) => { restoredFocus = options; } },
    },
    addEventListener(type, callback) { windowListeners.set(type, callback); },
    removeEventListener(type, callback) {
      assert.equal(windowListeners.get(type), callback);
      windowListeners.delete(type);
    },
    scrollTo: (...position) => {
      assert.equal(page.style.scrollBehavior, "auto");
      restoredScroll = position;
    },
  };
  try {
    const tree = hooks.render("FinanceModal", { title: "Edit this occurrence", onClose() {} });
    tree.props.ref.current = element;
    hooks.flushEffects();
    assert.equal(body.style.position, "fixed");
    assert.equal(body.style.top, "-640px");
    assert.equal(body.style.left, "-12px");
    assert.equal(body.style.overflow, "hidden");
    assert.equal(variables.get("--fp-dialog-viewport-height"), "740px");
    assert.equal(restoredFocus, undefined);

    viewport.height = 330;
    viewport.offsetTop = 20;
    viewportListeners.get("resize")();
    assert.equal(variables.get("--fp-dialog-viewport-height"), "330px");
    assert.equal(variables.get("--fp-dialog-viewport-top"), "20px");
    hooks.render("FinanceModal", { title: "Edit this occurrence", busy: true, onClose() {} });
    hooks.flushEffects();
    assert.equal(body.style.top, "-640px");
    assert.equal(viewportListeners.size, 2);

    hooks.unmount();
    assert.equal(element.open, false);
    assert.deepEqual(body.style, originalStyle);
    assert.deepEqual(restoredFocus, { preventScroll: true });
    assert.deepEqual(restoredScroll, [12, 640]);
    assert.equal(page.style.scrollBehavior, "smooth");
    assert.equal(viewportListeners.size, 0);
    assert.equal(windowListeners.size, 0);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("dialog cleanup does not focus a removed row after a refresh", () => {
  const previousWindow = globalThis.window;
  const hooks = harness();
  let restores = 0;
  const element = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  globalThis.window = {
    document: { activeElement: { isConnected: false, focus() { restores++; } } },
  };
  try {
    const tree = hooks.render("FinanceModal", { title: "Edit", onClose() {} });
    tree.props.ref.current = element;
    hooks.flushEffects();
    hooks.unmount();
    assert.equal(restores, 0);
  } finally {
    globalThis.window = previousWindow;
  }
});
