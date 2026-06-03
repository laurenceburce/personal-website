"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IcoClose, IcoHistory } from "../icons";

const CALC_ROWS = [
  ["C", "⌫", "%", "÷"],
  ["7", "8", "9", "×"],
  ["4", "5", "6", "−"],
  ["1", "2", "3", "+"],
  ["±", "0", ".", "="]
];

const CALC_HISTORY_STORAGE_KEY = "floating-toolbar-calculator-history";
const CALC_HISTORY_LIMIT = 30;
const CALC_HISTORY_WIDTH = 220;
const CALC_HISTORY_BODY_MAX_HEIGHT = 220;
const CALC_HISTORY_PANEL_HEIGHT = 280;
const CALC_HISTORY_GAP = 10;
const VIEWPORT_PADDING = 8;

function getCalculatorHistoryPosition(windowPos, windowWidth) {
  if (typeof window === "undefined") {
    return { x: 0, y: 0 };
  }

  const rightX = windowPos.x + windowWidth + CALC_HISTORY_GAP;
  const leftX = windowPos.x - CALC_HISTORY_WIDTH - CALC_HISTORY_GAP;
  const fitsRight = rightX + CALC_HISTORY_WIDTH <= window.innerWidth - VIEWPORT_PADDING;
  const maxY = Math.max(VIEWPORT_PADDING, window.innerHeight - CALC_HISTORY_PANEL_HEIGHT);

  return {
    x: fitsRight ? rightX : Math.max(VIEWPORT_PADDING, leftX),
    y: Math.max(VIEWPORT_PADDING, Math.min(maxY, windowPos.y))
  };
}

function calculate(a, b, op) {
  let result;

  if (op === "+") result = a + b;
  else if (op === "−") result = a - b;
  else if (op === "×") result = a * b;
  else if (op === "÷") return b === 0 ? "Error" : parseFloat((a / b).toPrecision(10));
  else return b;

  return parseFloat(result.toPrecision(10));
}

export default function Calculator({
  windowPos = { x: 0, y: 0 },
  windowWidth = 272,
  histOpen = false,
  onCloseHistory = () => {}
}) {
  const [display, setDisplay] = useState("0");
  const [prev, setPrev] = useState(null);
  const [op, setOp] = useState(null);
  const [waiting, setWaiting] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyReady, setHistoryReady] = useState(false);
  const historyPosition = getCalculatorHistoryPosition(windowPos, windowWidth);

  useEffect(() => {
    try {
      const savedHistory = window.localStorage.getItem(CALC_HISTORY_STORAGE_KEY);
      const parsedHistory = savedHistory ? JSON.parse(savedHistory) : [];

      if (Array.isArray(parsedHistory)) {
        setHistory(parsedHistory.filter((item) => typeof item === "string").slice(0, CALC_HISTORY_LIMIT));
      }
    } catch {
      setHistory([]);
    } finally {
      setHistoryReady(true);
    }
  }, []);

  useEffect(() => {
    if (!historyReady) return;

    try {
      window.localStorage.setItem(CALC_HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch {}
  }, [history, historyReady]);

  const handle = (btn) => {
    if (btn === "C") {
      setDisplay("0");
      setPrev(null);
      setOp(null);
      setWaiting(false);
      return;
    }

    if (btn === "⌫") {
      setDisplay((value) => (value.length > 1 ? value.slice(0, -1) : "0"));
      return;
    }

    if (btn === "±") {
      setDisplay((value) => (value === "0" ? "0" : String(-parseFloat(value))));
      return;
    }

    if (btn === "%") {
      setDisplay((value) => String(parseFloat(value) / 100));
      return;
    }

    if (["+", "−", "×", "÷"].includes(btn)) {
      const current = parseFloat(display);

      if (prev !== null && !waiting) {
        const result = calculate(prev, current, op);
        setDisplay(String(result));
        setPrev(typeof result === "number" ? result : null);
      } else {
        setPrev(current);
      }

      setOp(btn);
      setWaiting(true);
      return;
    }

    if (btn === "=") {
      if (prev !== null && op !== null) {
        const rightValue = parseFloat(display);
        const result = calculate(prev, rightValue, op);
        setHistory((items) => [`${prev} ${op} ${rightValue} = ${result}`, ...items].slice(0, CALC_HISTORY_LIMIT));
        setDisplay(String(result));
        setPrev(null);
        setOp(null);
        setWaiting(false);
      }

      return;
    }

    if (btn === ".") {
      if (waiting) {
        setDisplay("0.");
        setWaiting(false);
        return;
      }

      setDisplay((value) => (value.includes(".") ? value : `${value}.`));
      return;
    }

    setDisplay((value) => (waiting ? btn : value === "0" ? btn : value.length >= 12 ? value : value + btn));
    if (waiting) setWaiting(false);
  };

  const historyPopup = histOpen ? (
    <div
      className="ft-window ft-calc-hist-popup"
      style={{ left: historyPosition.x, top: historyPosition.y, width: CALC_HISTORY_WIDTH }}
    >
      <div className="ft-window-header">
        <span className="ft-window-header-left">
          <span className="ft-window-icon"><IcoHistory /></span>
          <span className="ft-window-title">History</span>
        </span>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          {history.length > 0 ? (
            <button className="ft-calc-hist-clear" onClick={() => setHistory([])} type="button">
              Clear
            </button>
          ) : null}
          <button className="ft-window-close" onClick={onCloseHistory} aria-label="Close" type="button">
            <IcoClose />
          </button>
        </div>
      </div>
      <div className="ft-window-body" style={{ padding: "6px 0" }}>
        {history.length === 0 ? (
          <p className="ft-calc-hist-empty">No calculations yet</p>
        ) : (
          <div className="ft-calc-hist-list" style={{ maxHeight: CALC_HISTORY_BODY_MAX_HEIGHT }}>
            {history.map((item, index) => (
              <div
                key={`${item}-${index}`}
                className="ft-calc-hist-item"
                onClick={() => {
                  const result = item.split(" = ")[1];
                  if (result) {
                    setDisplay(result);
                    setPrev(null);
                    setOp(null);
                    setWaiting(false);
                  }
                }}
              >
                {item}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  ) : null;

  return (
    <>
      {typeof document !== "undefined" && historyPopup
        ? createPortal(historyPopup, document.body)
        : null}

      <div className="ft-calc">
        <div className="ft-calc-display">
          {op && prev !== null ? (
            <span className="ft-calc-hist">{String(prev)} {op}</span>
          ) : null}
          <span className="ft-calc-val">
            {display.length > 12 ? Number(display).toExponential(4) : display}
          </span>
        </div>
        <div className="ft-calc-grid">
          {CALC_ROWS.flat().map((btn) => (
            <button
              key={btn}
              className={`ft-calc-btn${btn === "C" ? " ft-calc-ac" : ""}${["±", "%", "⌫"].includes(btn) ? " ft-calc-util" : ""}${["÷", "×", "−", "+"].includes(btn) ? " ft-calc-op" : ""}${btn === "=" ? " ft-calc-eq" : ""}`}
              onClick={() => handle(btn)}
              type="button"
            >
              {btn}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
