"use client";

import { useRef, useState } from "react";
import PageSketchOverlay from "./PageSketchOverlay";

const SKETCH_COLORS = ["#1e293b", "#ef4444", "#f97316", "#eab308", "#22c55e", "#38bdf8", "#818cf8", "#f9fafb"];

export default function SketchPad() {
  const pageOverlayRef = useRef(null);
  const [drawingEnabled, setDrawingEnabled] = useState(true);
  const [color, setColor] = useState("#38bdf8");
  const [size, setSize] = useState(4);
  const [eraser, setEraser] = useState(false);
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
        eraser={eraser}
      />
      <div className="ft-sketch-statusbar">
        <span className={`ft-sketch-status-dot${drawingEnabled ? "" : " paused"}`} aria-hidden="true" />
        <span className="ft-sketch-status-text">
          {drawingEnabled ? "Drawing" : "Clicking"}
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
                setEraser(false);
              }}
              aria-label={swatch}
              type="button"
            />
          ))}
        </div>
        <div className="ft-sketch-right">
          <button className={`ft-sk-btn${eraser ? " active" : ""}`} onClick={() => setEraser((value) => !value)} type="button">
            Eraser
          </button>
          <button className="ft-sk-btn" onClick={clear} type="button">Clear</button>
          <button className="ft-sk-btn" onClick={download} type="button" disabled={isSaving}>
            {isSaving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
      <div className="ft-sketch-sizerow">
        <span className="ft-sketch-sizelabel">Size</span>
        <input
          type="range"
          min="1"
          max="24"
          value={size}
          onChange={(event) => setSize(Number(event.target.value))}
          className="ft-range"
        />
        <span className="ft-sketch-sizenum">{size}px</span>
      </div>
    </div>
  );
}
