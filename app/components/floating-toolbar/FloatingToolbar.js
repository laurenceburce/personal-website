"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IcoCalc, IcoGrid, IcoHistory, IcoKeyboard, IcoMag, IcoMail, IcoPen } from "./icons";
import ToolWindow from "./ToolWindow";
import Calculator from "./tools/Calculator";
import Magnifier from "./tools/Magnifier";
import SketchPad from "./tools/SketchPad";
import VirtualKeyboard from "./tools/VirtualKeyboard";
import SidebarContactForm from "../portfolio/SidebarContactForm";
import useSidebarContactForm from "../../hooks/useSidebarContactForm";

const TOOLS = [
  { id: "calculator", label: "Calculator", Icon: IcoCalc, winIcon: <IcoCalc />, width: 272 },
  { id: "sketch", label: "Sketch", Icon: IcoPen, winIcon: <IcoPen />, width: 298 },
  { id: "keyboard", label: "Keyboard", Icon: IcoKeyboard, winIcon: <IcoKeyboard />, width: 432 },
  { id: "magnifier", label: "Magnifier", Icon: IcoMag, winIcon: <IcoMag />, width: 256 },
  { id: "contact", label: "Contact", Icon: IcoMail, winIcon: <IcoMail />, width: 320 }
];

const MENU_WIDTH_OFFSET = 172;
const APPROX_MENU_WIDTH = 168;
const TOOL_GAP = 16;
const VIEWPORT_MARGIN = 8;
const CIRCLE_SIZE = 52;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const clampCircleToViewport = (pos) => ({
  x: clamp(pos.x, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerWidth - CIRCLE_SIZE - VIEWPORT_MARGIN)),
  y: clamp(pos.y, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerHeight - CIRCLE_SIZE - VIEWPORT_MARGIN))
});

const getToolWidth = (id) => TOOLS.find((item) => item.id === id)?.width ?? 290;
const clampToolToViewport = (id, pos) => {
  const width = Math.min(getToolWidth(id), Math.max(220, window.innerWidth - VIEWPORT_MARGIN * 2));

  return {
    x: clamp(pos.x, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN)),
    y: clamp(pos.y, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerHeight - 56 - VIEWPORT_MARGIN))
  };
};

export default function FloatingToolbar() {
  const [mounted, setMounted] = useState(false);
  const [circlePos, setCirclePos] = useState({ x: 0, y: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const [openTools, setOpenTools] = useState({});
  const [calculatorHistoryOpen, setCalculatorHistoryOpen] = useState(false);
  const [keyboardMode, setKeyboardMode] = useState("abc");
  const [sketchColor, setSketchColor] = useState("#38bdf8");
  const [sketchMinimized, setSketchMinimized] = useState(false);
  const [sharedSketchMode, setSharedSketchMode] = useState(false);
  const contact = useSidebarContactForm();
  const circlePosRef = useRef({ x: 0, y: 0 });
  const openToolsRef = useRef({});
  const lastPointerRef = useRef(null);
  circlePosRef.current = circlePos;
  openToolsRef.current = openTools;

  useEffect(() => {
    if (window.self !== window.top) return;

    const x = window.innerWidth - 76;
    const y = window.innerWidth <= 740
      ? window.innerHeight - 128
      : Math.round(window.innerHeight * 0.62);
    setCirclePos({ x, y });

    const hasSketchShare = new URLSearchParams(window.location.search).has("sketchShare");
    setSharedSketchMode(hasSketchShare);

    if (hasSketchShare) {
      const width = getToolWidth("sketch");
      setSketchMinimized(true);
      setOpenTools({
        sketch: clampToolToViewport("sketch", {
          x: Math.max(8, window.innerWidth - width - 84),
          y: 84
        })
      });
    }

    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const fitToViewport = () => {
      setCirclePos((pos) => {
        const nextPos = clampCircleToViewport(pos);
        circlePosRef.current = nextPos;
        return nextPos;
      });
      setOpenTools((tools) => {
        const nextTools = {};

        Object.entries(tools).forEach(([id, pos]) => {
          nextTools[id] = clampToolToViewport(id, pos);
        });

        openToolsRef.current = nextTools;
        return nextTools;
      });
    };

    window.addEventListener("resize", fitToViewport);
    window.addEventListener("orientationchange", fitToViewport);
    fitToViewport();

    return () => {
      window.removeEventListener("resize", fitToViewport);
      window.removeEventListener("orientationchange", fitToViewport);
    };
  }, [mounted]);

  useEffect(() => {
    const rememberPointer = (event) => {
      lastPointerRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        pointerType: event.pointerType || "mouse"
      };
    };

    window.addEventListener("pointerdown", rememberPointer, true);
    window.addEventListener("pointermove", rememberPointer, true);
    window.addEventListener("mousemove", rememberPointer, true);

    return () => {
      window.removeEventListener("pointerdown", rememberPointer, true);
      window.removeEventListener("pointermove", rememberPointer, true);
      window.removeEventListener("mousemove", rememberPointer, true);
    };
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
    setMenuOpen(false);

    if (openToolsRef.current[id]) {
      if (id === "calculator") {
        setCalculatorHistoryOpen(false);
      }
      if (id === "sketch") {
        setSketchMinimized(false);
      }

      setOpenTools((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
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
    if (id === "sketch") {
      setSketchMinimized(false);
    }
  }, []);

  const closeTool = useCallback((id) => {
    if (id === "calculator") {
      setCalculatorHistoryOpen(false);
    }
    if (id === "sketch") {
      setSketchMinimized(false);
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
        const isKeyboard = id === "keyboard";
        const isSketch = id === "sketch";

        return (
          <ToolWindow
            key={id}
            title={meta.label}
            icon={id === "sketch" ? <span style={{ color: sketchColor }}><IcoPen /></span> : meta.winIcon}
            onClose={() => closeTool(id)}
            initX={pos.x}
            initY={pos.y}
            width={meta.width}
            minimized={isSketch && sketchMinimized}
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
              ) : isKeyboard ? (
                <span className="ft-kb-header-mode" role="group" aria-label="Keyboard layout">
                  <button
                    className={keyboardMode === "abc" ? "active" : ""}
                    onClick={() => setKeyboardMode("abc")}
                    type="button"
                    aria-pressed={keyboardMode === "abc"}
                  >
                    ABC
                  </button>
                  <button
                    className={keyboardMode === "sym" ? "active" : ""}
                    onClick={() => setKeyboardMode("sym")}
                    type="button"
                    aria-pressed={keyboardMode === "sym"}
                  >
                    #+=
                  </button>
                </span>
              ) : isSketch ? (
                <button
                  className={`ft-window-tool-btn${sketchMinimized ? " active" : ""}`}
                  onClick={() => setSketchMinimized((value) => !value)}
                  aria-label={sketchMinimized ? "Restore sketch" : "Minimize sketch"}
                  aria-pressed={sketchMinimized}
                  title={sketchMinimized ? "Restore" : "Minimize"}
                  type="button"
                >
                  {sketchMinimized ? "+" : "-"}
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
                {id === "sketch" ? (
                  <SketchPad
                    initialDrawingEnabled={!sharedSketchMode}
                    onColorChange={setSketchColor}
                  />
                ) : null}
                {id === "keyboard" ? <VirtualKeyboard mode={keyboardMode} /> : null}
                {id === "magnifier" ? <Magnifier initialPointer={lastPointerRef.current} /> : null}
                {id === "contact" ? (
                  <SidebarContactForm
                    form={contact.form}
                    errors={contact.errors}
                    status={contact.status}
                    isSubmitting={contact.isSubmitting}
                    onChange={contact.handleChange}
                    onSubmit={contact.handleSubmit}
                  />
                ) : null}
              </>
            )}
          </ToolWindow>
        );
      })}
    </>
  );
}
