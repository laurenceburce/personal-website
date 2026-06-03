"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IcoCalc, IcoGrid, IcoHistory, IcoKeyboard, IcoMag, IcoPen } from "./icons";
import ToolWindow from "./ToolWindow";
import Calculator from "./tools/Calculator";
import Magnifier from "./tools/Magnifier";
import SketchPad from "./tools/SketchPad";
import VirtualKeyboard from "./tools/VirtualKeyboard";

const TOOLS = [
  { id: "calculator", label: "Calculator", Icon: IcoCalc, winIcon: <IcoCalc />, width: 272 },
  { id: "sketch", label: "Sketch", Icon: IcoPen, winIcon: <IcoPen />, width: 298 },
  { id: "keyboard", label: "Keyboard", Icon: IcoKeyboard, winIcon: <IcoKeyboard />, width: 356 },
  { id: "magnifier", label: "Magnifier", Icon: IcoMag, winIcon: <IcoMag />, width: 256 }
];

const MENU_WIDTH_OFFSET = 172;
const APPROX_MENU_WIDTH = 168;
const TOOL_GAP = 16;

export default function FloatingToolbar() {
  const [mounted, setMounted] = useState(false);
  const [circlePos, setCirclePos] = useState({ x: 0, y: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const [openTools, setOpenTools] = useState({});
  const [calculatorHistoryOpen, setCalculatorHistoryOpen] = useState(false);
  const circlePosRef = useRef({ x: 0, y: 0 });
  const openToolsRef = useRef({});
  circlePosRef.current = circlePos;
  openToolsRef.current = openTools;

  useEffect(() => {
    if (window.self !== window.top) return;

    const x = window.innerWidth - 76;
    const y = Math.round(window.innerHeight * 0.62);
    setCirclePos({ x, y });
    setMounted(true);
  }, []);

  const startCircleDrag = useCallback((event) => {
    if (event.button !== 0) return;

    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    const originX = circlePosRef.current.x;
    const originY = circlePosRef.current.y;
    let moved = false;

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        moved = true;
      }

      const nextPos = {
        x: Math.max(4, Math.min(window.innerWidth - 60, originX + dx)),
        y: Math.max(4, Math.min(window.innerHeight - 60, originY + dy))
      };

      circlePosRef.current = nextPos;
      setCirclePos(nextPos);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);

      if (!moved) {
        setMenuOpen((open) => !open);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const openTool = useCallback((id) => {
    if (openToolsRef.current[id]) {
      setMenuOpen(false);
      return;
    }

    const { x, y } = circlePosRef.current;
    const tool = TOOLS.find((item) => item.id === id);
    const width = tool?.width ?? 290;
    const offset = Object.keys(openToolsRef.current).length;
    const isRight = x > window.innerWidth / 2;
    const baseX = isRight
      ? x - MENU_WIDTH_OFFSET - width - TOOL_GAP
      : x + 64 + APPROX_MENU_WIDTH + TOOL_GAP;

    setOpenTools((prev) => ({
      ...prev,
      [id]: {
        x: Math.max(8, Math.min(window.innerWidth - width - 8, baseX + offset * 20)),
        y: Math.max(8, Math.min(window.innerHeight - 420, y - 60 + offset * 24))
      }
    }));
    setMenuOpen(false);
  }, []);

  const closeTool = useCallback((id) => {
    if (id === "calculator") {
      setCalculatorHistoryOpen(false);
    }

    setOpenTools((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  if (!mounted) return null;

  const menuLeft = circlePos.x > window.innerWidth / 2
    ? circlePos.x - MENU_WIDTH_OFFSET
    : circlePos.x + 64;
  const menuTop = Math.max(8, Math.min(window.innerHeight - 240, circlePos.y - 8));

  return (
    <>
      {menuOpen ? (
        <div className="ft-backdrop" onClick={() => setMenuOpen(false)} />
      ) : null}

      <div
        className={`ft-circle${menuOpen ? " open" : ""}`}
        style={{ left: circlePos.x, top: circlePos.y }}
        onPointerDown={startCircleDrag}
        role="button"
        tabIndex={0}
        aria-label="Open tools"
        aria-expanded={menuOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            setMenuOpen((open) => !open);
          }
        }}
      >
        <IcoGrid />
      </div>

      {menuOpen ? (
        <div className="ft-menu" style={{ left: menuLeft, top: menuTop }}>
          {TOOLS.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`ft-menu-item${openTools[id] ? " ft-menu-item-active" : ""}`}
              onClick={() => openTool(id)}
              type="button"
            >
              <span className="ft-menu-icon"><Icon /></span>
              <span>{label}</span>
            </button>
          ))}
        </div>
      ) : null}

      {Object.entries(openTools).map(([id, pos]) => {
        const meta = TOOLS.find((item) => item.id === id);
        if (!meta) return null;

        const isCalculator = id === "calculator";

        return (
          <ToolWindow
            key={id}
            title={meta.label}
            icon={meta.winIcon}
            onClose={() => closeTool(id)}
            initX={pos.x}
            initY={pos.y}
            width={meta.width}
            headerActions={
              isCalculator ? (
                <button
                  className={`ft-window-tool-btn${calculatorHistoryOpen ? " active" : ""}`}
                  onClick={() => setCalculatorHistoryOpen((open) => !open)}
                  aria-label="Toggle history"
                  aria-pressed={calculatorHistoryOpen}
                  title="History"
                  type="button"
                >
                  <IcoHistory />
                </button>
              ) : null
            }
          >
            {({ windowPos, windowWidth }) => (
              <>
                {isCalculator ? (
                  <Calculator
                    windowPos={windowPos}
                    windowWidth={windowWidth}
                    histOpen={calculatorHistoryOpen}
                    onCloseHistory={() => setCalculatorHistoryOpen(false)}
                  />
                ) : null}
                {id === "sketch" ? <SketchPad /> : null}
                {id === "keyboard" ? <VirtualKeyboard /> : null}
                {id === "magnifier" ? <Magnifier /> : null}
              </>
            )}
          </ToolWindow>
        );
      })}
    </>
  );
}
