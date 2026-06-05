"use client";

import { useRef, useState } from "react";
import PageSketchOverlay from "./PageSketchOverlay";

const SKETCH_COLORS = ["#1e293b", "#ef4444", "#f97316", "#eab308", "#22c55e", "#38bdf8", "#818cf8", "#f9fafb"];
const STICKERS = ["★", "✓", "!", "?", "❤", "→", "📌", "💡"];

export default function SketchPad() {
  const pageOverlayRef = useRef(null);
  const [drawingEnabled, setDrawingEnabled] = useState(true);
  const [color, setColor] = useState("#38bdf8");
  const [size, setSize] = useState(4);
  const [tool, setTool] = useState("pen");
  const [sticker, setSticker] = useState(STICKERS[0]);
  const [isSaving, setIsSaving] = useState(false);

  const clear = () => {
    pageOverlayRef.current?.clear();
  };

  const download = async () => {
    try {
      setIsSaving(true);
      await pageOverlayRef.current?.download();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="ft-sketch">
      <PageSketchOverlay
        ref={pageOverlayRef}
        drawingEnabled={drawingEnabled}
        color={color}
        size={size}
        tool={tool}
        sticker={sticker}
      />
      <div className="ft-sketch-statusbar">
        <span className={`ft-sketch-status-dot${drawingEnabled ? "" : " paused"}`} aria-hidden="true" />
        <span className="ft-sketch-status-text">
          {drawingEnabled ? `${tool === "sticker" ? "Sticker" : tool === "highlight" ? "Highlight" : tool === "eraser" ? "Erasing" : "Drawing"}` : "Clicking"}
        </span>
        <button
          className={`ft-sketch-toggle${drawingEnabled ? " active" : ""}`}
          onClick={() => setDrawingEnabled((enabled) => !enabled)}
          type="button"
          aria-pressed={drawingEnabled}
        >
          {drawingEnabled ? "Draw on" : "Draw off"}
        </button>
      </div>
      <div className="ft-sketch-top">
        <div className="ft-sketch-colors">
          {SKETCH_COLORS.map((swatch) => (
            <button
              key={swatch}
              className={`ft-color-dot${color === swatch && !eraser ? " active" : ""}`}
              style={{ background: swatch, outline: swatch === "#f9fafb" ? "1px solid #cbd5e1" : "none" }}
              onClick={() => {
                setColor(swatch);
                setTool("pen");
              }}
              aria-label={swatch}
              type="button"
            />
          ))}
        </div>
        <div className="ft-sketch-right">
          <button className={`ft-sk-btn${tool === "pen" ? " active" : ""}`} onClick={() => setTool("pen")} type="button">
            Pen
          </button>
          <button className={`ft-sk-btn${tool === "highlight" ? " active" : ""}`} onClick={() => setTool("highlight")} type="button">
            Highlight
          </button>
          <button className={`ft-sk-btn${tool === "eraser" ? " active" : ""}`} onClick={() => setTool("eraser")} type="button">
            Eraser
          </button>
        </div>
      </div>
      <div className="ft-sketch-stickers" role="group" aria-label="Stickers">
        {STICKERS.map((item) => (
          <button
            key={item}
            className={`ft-sticker-btn${sticker === item && tool === "sticker" ? " active" : ""}`}
            draggable
            onClick={() => {
              setSticker(item);
              setTool("sticker");
            }}
            onDragStart={(event) => {
              setSticker(item);
              setTool("sticker");
              event.dataTransfer.setData("text/plain", item);
              event.dataTransfer.effectAllowed = "copy";
            }}
            type="button"
            aria-label={`Sticker ${item}`}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="ft-sketch-sizerow">
        <span className="ft-sketch-sizelabel">Size</span>
        <input
          type="range"
          min="1"
          max="56"
          value={size}
          onChange={(event) => setSize(Number(event.target.value))}
          className="ft-range"
        />
        <span className="ft-sketch-sizenum">{size}px</span>
      </div>
      <div className="ft-sketch-actions">
        <button className="ft-sk-btn" onClick={clear} type="button">Clear</button>
        <button className="ft-sk-btn" onClick={download} type="button" disabled={isSaving}>
          {isSaving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}
