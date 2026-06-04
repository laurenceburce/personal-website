"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";

const MAX_DPR = 2;
const SKETCH_CHANGED_EVENT = "floating-toolbar:sketch-changed";
const FLOATING_UI_SELECTOR = [
  ".ft-window",
  ".ft-circle",
  ".ft-menu",
  ".ft-backdrop",
  ".ft-click-bubble",
  ".ft-page-sketch-layer",
  ".ft-mag-lens"
].join(",");

const notifySketchChanged = (point = null, hasDrawing = false) => {
  const detail = {
    hasDrawing
  };

  if (point) {
    detail.clientX = point.x - window.scrollX;
    detail.clientY = point.y - window.scrollY;
  }

  window.dispatchEvent(new CustomEvent(SKETCH_CHANGED_EVENT, { detail }));
};

const PageSketchOverlay = forwardRef(function PageSketchOverlay({
  drawingEnabled,
  color,
  size,
  eraser
}, ref) {
  const [mounted, setMounted] = useState(false);
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const hasDrawingRef = useRef(false);
  const lastPointRef = useRef(null);
  const toolRef = useRef({ color, size, eraser });
  const dimensionsRef = useRef({ width: 0, height: 0, dpr: 1 });

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    toolRef.current = { color, size, eraser };
  }, [color, size, eraser]);

  const resizeCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.dataset.hasDrawing = hasDrawingRef.current ? "true" : "false";

    const nextWidth = Math.ceil(Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth ?? 0,
      window.innerWidth
    ));
    const nextHeight = Math.ceil(Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0,
      window.innerHeight
    ));
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const previous = dimensionsRef.current;

    if (
      previous.width === nextWidth &&
      previous.height === nextHeight &&
      previous.dpr === dpr
    ) {
      return;
    }

    let snapshot = null;
    if (canvas.width > 0 && canvas.height > 0 && previous.width > 0 && previous.height > 0) {
      snapshot = document.createElement("canvas");
      snapshot.width = canvas.width;
      snapshot.height = canvas.height;
      snapshot.getContext("2d").drawImage(canvas, 0, 0);
    }

    canvas.width = Math.max(1, Math.floor(nextWidth * dpr));
    canvas.height = Math.max(1, Math.floor(nextHeight * dpr));
    canvas.style.width = `${nextWidth}px`;
    canvas.style.height = `${nextHeight}px`;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (snapshot) {
      ctx.drawImage(snapshot, 0, 0, previous.width, previous.height);
    }

    dimensionsRef.current = { width: nextWidth, height: nextHeight, dpr };
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const { dpr } = dimensionsRef.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hasDrawingRef.current = false;
    canvas.dataset.hasDrawing = "false";
    notifySketchChanged(null, false);
  };

  const downloadCanvas = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    resizeCanvas();

    const { default: html2canvas } = await import("html2canvas");
    const { width, height } = dimensionsRef.current;
    const scale = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const portfolioCanvas = await html2canvas(document.body, {
      backgroundColor: null,
      height,
      ignoreElements: (element) => Boolean(element.closest?.(FLOATING_UI_SELECTOR)),
      logging: false,
      scale,
      scrollX: 0,
      scrollY: 0,
      useCORS: true,
      width,
      windowHeight: height,
      windowWidth: width
    });
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = portfolioCanvas.width;
    outputCanvas.height = portfolioCanvas.height;

    const outputContext = outputCanvas.getContext("2d");
    outputContext.drawImage(portfolioCanvas, 0, 0);
    outputContext.drawImage(
      canvas,
      0,
      0,
      canvas.width,
      canvas.height,
      0,
      0,
      outputCanvas.width,
      outputCanvas.height
    );

    const link = document.createElement("a");
    link.href = outputCanvas.toDataURL("image/png");
    link.download = "portfolio-annotations.png";
    link.click();
  };

  useImperativeHandle(ref, () => ({
    clear: clearCanvas,
    download: downloadCanvas
  }));

  useEffect(() => {
    if (!mounted) return;

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    let resizeObserver = null;
    if ("ResizeObserver" in window) {
      resizeObserver = new ResizeObserver(resizeCanvas);
      resizeObserver.observe(document.documentElement);
      if (document.body) {
        resizeObserver.observe(document.body);
      }
    }

    return () => {
      window.removeEventListener("resize", resizeCanvas);
      resizeObserver?.disconnect();
    };
  }, [mounted]);

  const getPoint = (event) => ({
    x: event.pageX,
    y: event.pageY
  });

  const drawDot = (point) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { color: strokeColor, size: strokeSize, eraser: isErasing } = toolRef.current;
    const ctx = canvas.getContext("2d");
    hasDrawingRef.current = true;
    canvas.dataset.hasDrawing = "true";
    ctx.save();
    ctx.globalCompositeOperation = isErasing ? "destination-out" : "source-over";
    ctx.fillStyle = isErasing ? "#000" : strokeColor;
    ctx.beginPath();
    ctx.arc(point.x, point.y, strokeSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    notifySketchChanged(point, true);
  };

  const drawLine = (from, to) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { color: strokeColor, size: strokeSize, eraser: isErasing } = toolRef.current;
    const ctx = canvas.getContext("2d");
    hasDrawingRef.current = true;
    canvas.dataset.hasDrawing = "true";
    ctx.save();
    ctx.globalCompositeOperation = isErasing ? "destination-out" : "source-over";
    ctx.strokeStyle = isErasing ? "#000" : strokeColor;
    ctx.lineWidth = strokeSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
    notifySketchChanged(to, true);
  };

  const onPointerDown = (event) => {
    if (event.pointerType !== "touch" && event.button !== 0) return;

    event.preventDefault();
    resizeCanvas();

    const point = getPoint(event);
    drawingRef.current = true;
    lastPointRef.current = point;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drawDot(point);
  };

  const onPointerMove = (event) => {
    if (!drawingRef.current || !lastPointRef.current) return;

    event.preventDefault();
    const point = getPoint(event);
    drawLine(lastPointRef.current, point);
    lastPointRef.current = point;
  };

  const stopDrawing = (event) => {
    drawingRef.current = false;
    lastPointRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  if (!mounted) return null;

  return createPortal(
    <div
      className={`ft-page-sketch-layer${drawingEnabled ? " drawing" : ""}`}
      aria-hidden="true"
    >
      <canvas
        ref={canvasRef}
        className="ft-page-sketch-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDrawing}
        onPointerCancel={stopDrawing}
        onContextMenu={(event) => event.preventDefault()}
      />
    </div>,
    document.body
  );
});

export default PageSketchOverlay;
