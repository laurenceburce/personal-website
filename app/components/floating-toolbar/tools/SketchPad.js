"use client";

import { useEffect, useRef, useState } from "react";

const SKETCH_COLORS = ["#1e293b", "#ef4444", "#f97316", "#eab308", "#22c55e", "#38bdf8", "#818cf8", "#f9fafb"];

export default function SketchPad() {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const lastPoint = useRef(null);
  const [color, setColor] = useState("#38bdf8");
  const [size, setSize] = useState(4);
  const [eraser, setEraser] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, []);

  const getPoint = (event) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const source = event.touches ? event.touches[0] : event;

    return {
      x: (source.clientX - rect.left) * scaleX,
      y: (source.clientY - rect.top) * scaleY
    };
  };

  const drawDot = (point) => {
    const ctx = canvasRef.current.getContext("2d");
    ctx.fillStyle = eraser ? "#ffffff" : color;
    ctx.beginPath();
    ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  };

  const onDown = (event) => {
    event.preventDefault();
    drawing.current = true;

    const point = getPoint(event);
    lastPoint.current = point;
    drawDot(point);
  };

  const onMove = (event) => {
    if (!drawing.current) return;

    event.preventDefault();

    const ctx = canvasRef.current.getContext("2d");
    const point = getPoint(event);
    ctx.strokeStyle = eraser ? "#ffffff" : color;
    ctx.lineWidth = size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPoint.current = point;
  };

  const onUp = () => {
    drawing.current = false;
    lastPoint.current = null;
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };

  const download = () => {
    const link = document.createElement("a");
    link.href = canvasRef.current.toDataURL("image/png");
    link.download = "sketch.png";
    link.click();
  };

  return (
    <div className="ft-sketch">
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
          <button className="ft-sk-btn" onClick={download} type="button">Save</button>
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
      <canvas
        ref={canvasRef}
        width={262}
        height={192}
        className="ft-sketch-canvas"
        style={{ touchAction: "none" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
      />
    </div>
  );
}
