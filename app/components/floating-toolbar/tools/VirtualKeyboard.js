"use client";

import { useCallback, useState } from "react";

const KB_ABC = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["⇧", "z", "x", "c", "v", "b", "n", "m", "⌫"],
  ["Space", ".", ",", "?", "↵"]
];

const KB_SYM = [
  ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")"],
  ["-", "+", "=", "_", "/", "\\", "[", "]", "{", "}"],
  [";", ":", "'", "\"", ",", ".", "<", ">", "|", "~"],
  ["⌫", "Space", "ABC", "↵"]
];

function insertChar(char) {
  const element = document.activeElement;
  const isInput = element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA");

  if (isInput) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    const nextValue = element.value.slice(0, start) + char + element.value.slice(end);
    const proto = element.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;

    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, nextValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.selectionStart = element.selectionEnd = start + char.length;
    return;
  }

  document.execCommand("insertText", false, char);
}

function deleteChar() {
  const element = document.activeElement;
  const isInput = element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA");

  if (isInput) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    const nextValue = start === end
      ? element.value.slice(0, Math.max(0, start - 1)) + element.value.slice(end)
      : element.value.slice(0, start) + element.value.slice(end);
    const nextStart = start === end ? Math.max(0, start - 1) : start;
    const proto = element.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;

    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, nextValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.selectionStart = element.selectionEnd = nextStart;
    return;
  }

  document.execCommand("delete");
}

export default function VirtualKeyboard() {
  const [mode, setMode] = useState("abc");
  const [shift, setShift] = useState(false);
  const [caps, setCaps] = useState(false);

  const pressKey = useCallback((key) => {
    if (key === "ABC") {
      setMode("abc");
      return;
    }

    if (key === "!@#") {
      setMode("sym");
      return;
    }

    if (key === "⇧") {
      if (shift) {
        setShift(false);
        setCaps((value) => !value);
      } else {
        setShift(true);
      }
      return;
    }

    if (key === "⌫") {
      deleteChar();
      return;
    }

    let char = key === "Space" ? " " : key === "↵" ? "\n" : key;
    const upper = shift || caps;

    if (char.length === 1 && /[a-z]/i.test(char)) {
      char = upper ? char.toUpperCase() : char.toLowerCase();
    }

    insertChar(char);
    if (shift) setShift(false);
  }, [shift, caps]);

  const upper = shift || caps;
  const rows = mode === "abc" ? KB_ABC : KB_SYM;

  return (
    <div className="ft-keyboard">
      <div className="ft-kb-tabs">
        <button
          className={`ft-kb-tab${mode === "abc" ? " active" : ""}`}
          onPointerDown={(event) => {
            event.preventDefault();
            setMode("abc");
          }}
          type="button"
        >
          ABC
        </button>
        <button
          className={`ft-kb-tab${mode === "sym" ? " active" : ""}`}
          onPointerDown={(event) => {
            event.preventDefault();
            setMode("sym");
          }}
          type="button"
        >
          !@#
        </button>
      </div>
      {rows.map((row, rowIndex) => (
        <div key={`${mode}-${rowIndex}`} className="ft-kb-row">
          {row.map((key) => {
            const display = key.length === 1 && /[a-z]/i.test(key) ? (upper ? key.toUpperCase() : key) : key;
            const className = [
              "ft-kb-key",
              key === "Space" ? "ft-kb-space" : "",
              key === "↵" ? "ft-kb-enter" : "",
              key === "⌫" ? "ft-kb-back" : "",
              key === "⇧" ? "ft-kb-shift" : "",
              key === "⇧" && (shift || caps) ? "ft-kb-active" : "",
              key === "ABC" ? "ft-kb-mode" : ""
            ].filter(Boolean).join(" ");

            return (
              <button
                key={key}
                className={className}
                onPointerDown={(event) => {
                  event.preventDefault();
                  pressKey(key);
                }}
                type="button"
              >
                {display}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
