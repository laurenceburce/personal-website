"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";

const MAX_DPR = 2;
const SKETCH_CHANGED_EVENT = "floating-toolbar:sketch-changed";
const STICKER_BASE_SIZE = 28;
const FLOATING_UI_SELECTOR = [
  ".ft-window",
  ".ft-circle",
  ".ft-menu",
  ".ft-backdrop",
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
  tool,
  sticker
}, ref) {
  const [mounted, setMounted] = useState(false);
  const [stickers, setStickers] = useState([]);
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const hasDrawingRef = useRef(false);
  const lastPointRef = useRef(null);
  const pendingMarkupRef = useRef(null);
  const stickerDragRef = useRef(null);
  const stickersRef = useRef([]);
  const toolRef = useRef({ color, size, tool, sticker });
  const dimensionsRef = useRef({ width: 0, height: 0, dpr: 1 });

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    toolRef.current = { color, size, tool, sticker };
  }, [color, size, tool, sticker]);

  useEffect(() => {
    stickersRef.current = stickers;
  }, [stickers]);

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
    setStickers([]);
    notifySketchChanged(null, false);
  };

  const loadMarkup = (markup) => {
    if (!markup) return;

    const canvas = canvasRef.current;
    if (!canvas) {
      pendingMarkupRef.current = markup;
      return;
    }

    resizeCanvas();

    const { dpr, width, height } = dimensionsRef.current;
    const sourceCssWidth = Number(markup.cssWidth) || width || 1;
    const sourceCssHeight = Number(markup.cssHeight) || height || 1;
    const scaleX = width / sourceCssWidth;
    const scaleY = height / sourceCssHeight;
    const ctx = canvas.getContext("2d");

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const nextStickers = Array.isArray(markup.stickers)
      ? markup.stickers.map((item) => ({
          id: item.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          value: String(item.value || "").slice(0, 2),
          x: Number(item.x || 0) * scaleX,
          y: Number(item.y || 0) * scaleY,
          size: Math.max(STICKER_BASE_SIZE, Number(item.size || STICKER_BASE_SIZE) * Math.min(scaleX, scaleY))
        }))
      : [];

    setStickers(nextStickers);

    if (typeof markup.canvasDataUrl !== "string") {
      hasDrawingRef.current = nextStickers.length > 0;
      canvas.dataset.hasDrawing = hasDrawingRef.current ? "true" : "false";
      notifySketchChanged(null, hasDrawingRef.current);
      return;
    }

    const image = new Image();
    image.onload = () => {
      ctx.drawImage(image, 0, 0, sourceCssWidth * scaleX, sourceCssHeight * scaleY);
      hasDrawingRef.current = true;
      canvas.dataset.hasDrawing = "true";
      notifySketchChanged(null, true);
    };
    image.src = markup.canvasDataUrl;
  };

  const getMarkup = () => {
    resizeCanvas();

    const canvas = canvasRef.current;
    if (!canvas) return null;

    const { width, height } = dimensionsRef.current;

    return {
      version: 1,
      canvasDataUrl: canvas.toDataURL("image/png"),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      cssWidth: width,
      cssHeight: height,
      stickers: stickersRef.current.map((item) => ({
        id: item.id,
        value: item.value,
        x: item.x,
        y: item.y,
        size: item.size
      }))
    };
  };

  const downloadCanvas = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Read fresh full-page dimensions before any state changes
    const freshWidth = Math.ceil(Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth ?? 0,
      window.innerWidth
    ));
    const freshHeight = Math.ceil(Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0,
      window.innerHeight
    ));

    resizeCanvas();

    const { default: html2canvas } = await import("html2canvas");
    const scale = Math.min(window.devicePixelRatio || 1, MAX_DPR);

    // Force all reveal-animated sections fully visible before capturing.
    // Without this, sections below the viewport have opacity:0 / translateY from
    // the scroll-driven reveal animation, making the bottom appear cut off.
    const revealEls = Array.from(document.querySelectorAll(".reveal"));
    const revealSnapshot = revealEls.map((el) => ({
      el,
      progress: el.style.getPropertyValue("--reveal-progress"),
      visible: el.classList.contains("visible")
    }));
    revealEls.forEach((el) => {
      el.style.setProperty("--reveal-progress", "1");
      el.classList.add("visible");
    });

    const savedScrollX = window.scrollX;
    const savedScrollY = window.scrollY;
    window.scrollTo(0, 0);
    // Two frames: one for scroll, one for layout reflow after reveal override
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const portfolioCanvas = await html2canvas(document.body, {
      backgroundColor: null,
      height: freshHeight,
      ignoreElements: (element) => Boolean(element.closest?.(FLOATING_UI_SELECTOR)),
      logging: false,
      scale,
      scrollX: 0,
      scrollY: 0,
      useCORS: true,
      width: freshWidth,
      windowHeight: freshHeight,
      windowWidth: freshWidth
    });

    // Restore reveal animation states
    revealSnapshot.forEach(({ el, progress, visible }) => {
      if (progress !== "") {
        el.style.setProperty("--reveal-progress", progress);
      } else {
        el.style.removeProperty("--reveal-progress");
      }
      if (!visible) el.classList.remove("visible");
    });
    window.scrollTo(savedScrollX, savedScrollY);

    // Size output to fresh dimensions — html2canvas can return a shorter canvas
    // if it clips at viewport height, so we size explicitly and draw html2canvas
    // output into it rather than inheriting its (potentially clipped) dimensions.
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = freshWidth * scale;
    outputCanvas.height = freshHeight * scale;

    const outputContext = outputCanvas.getContext("2d");
    outputContext.drawImage(portfolioCanvas, 0, 0);
    outputContext.drawImage(
      canvas,
      0, 0, canvas.width, canvas.height,
      0, 0, outputCanvas.width, outputCanvas.height
    );
    stickersRef.current.forEach((item) => {
      outputContext.save();
      outputContext.font = `${Math.round(item.size * scale)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      outputContext.textAlign = "center";
      outputContext.textBaseline = "middle";
      outputContext.fillText(item.value, item.x * scale, item.y * scale);
      outputContext.restore();
    });

    const link = document.createElement("a");
    link.href = outputCanvas.toDataURL("image/png");
    link.download = "portfolio-annotations.png";
    link.click();
  };

  useImperativeHandle(ref, () => ({
    clear: clearCanvas,
    download: downloadCanvas,
    getMarkup,
    loadMarkup
  }));

  useEffect(() => {
    if (!mounted) return;

    resizeCanvas();
    if (pendingMarkupRef.current) {
      const markup = pendingMarkupRef.current;
      pendingMarkupRef.current = null;
      loadMarkup(markup);
    }
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

  const markChanged = (point) => {
    hasDrawingRef.current = true;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.dataset.hasDrawing = "true";
    }
    notifySketchChanged(point, true);
  };

  const addSticker = (point, value = toolRef.current.sticker) => {
    const cleanValue = value?.trim?.() || toolRef.current.sticker;
    const nextSticker = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      value: cleanValue.slice(0, 2),
      x: point.x,
      y: point.y,
      size: Math.max(STICKER_BASE_SIZE, toolRef.current.size * 1.6)
    };

    setStickers((items) => [...items, nextSticker]);
    markChanged(point);
  };

  const removeSticker = (id, point) => {
    setStickers((items) => items.filter((item) => item.id !== id));
    markChanged(point);
  };

  const drawDot = (point) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { color: strokeColor, size: strokeSize, tool: activeTool } = toolRef.current;
    const isErasing = activeTool === "eraser";
    const isHighlighting = activeTool === "highlight";
    const ctx = canvas.getContext("2d");
    markChanged(point);
    ctx.save();
    ctx.globalCompositeOperation = isErasing ? "destination-out" : "source-over";
    ctx.globalAlpha = isHighlighting ? 0.35 : 1;
    ctx.fillStyle = isErasing ? "#000" : strokeColor;
    ctx.beginPath();
    ctx.arc(point.x, point.y, (isHighlighting ? Math.max(strokeSize, 16) : strokeSize) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const drawLine = (from, to) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { color: strokeColor, size: strokeSize, tool: activeTool } = toolRef.current;
    const isErasing = activeTool === "eraser";
    const isHighlighting = activeTool === "highlight";
    const ctx = canvas.getContext("2d");
    markChanged(to);
    ctx.save();
    ctx.globalCompositeOperation = isErasing ? "destination-out" : "source-over";
    ctx.globalAlpha = isHighlighting ? 0.35 : 1;
    ctx.strokeStyle = isErasing ? "#000" : strokeColor;
    ctx.lineWidth = isHighlighting ? Math.max(strokeSize, 16) : strokeSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  };

  const onPointerDown = (event) => {
    if (!event.isPrimary) return;
    if (event.pointerType !== "touch" && event.button !== 0) return;

    event.preventDefault();
    resizeCanvas();

    const point = getPoint(event);
    if (toolRef.current.tool === "sticker") {
      addSticker(point);
      return;
    }

    drawingRef.current = true;
    lastPointRef.current = point;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drawDot(point);
  };

  const onPointerMove = (event) => {
    if (!event.isPrimary || !drawingRef.current || !lastPointRef.current) return;

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

  const onStickerPointerDown = (event, item) => {
    if (!event.isPrimary) return;
    if (event.pointerType !== "touch" && event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();

    const point = getPoint(event);
    if (toolRef.current.tool === "eraser") {
      removeSticker(item.id, point);
      return;
    }

    stickerDragRef.current = {
      id: item.id,
      offsetX: point.x - item.x,
      offsetY: point.y - item.y
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onStickerPointerMove = (event) => {
    if (!event.isPrimary || !stickerDragRef.current) return;

    event.preventDefault();
    event.stopPropagation();
    const point = getPoint(event);
    const { id, offsetX, offsetY } = stickerDragRef.current;
    const nextPoint = {
      x: point.x - offsetX,
      y: point.y - offsetY
    };

    setStickers((items) => items.map((item) => (
      item.id === id ? { ...item, ...nextPoint } : item
    )));
    markChanged(nextPoint);
  };

  const stopStickerDrag = (event) => {
    stickerDragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const onDrop = (event) => {
    event.preventDefault();
    const droppedSticker = event.dataTransfer.getData("text/plain");
    addSticker({ x: event.pageX, y: event.pageY }, droppedSticker);
  };

  if (!mounted) return null;

  return createPortal(
    <div
      className={`ft-page-sketch-layer${drawingEnabled ? " drawing" : ""}`}
      aria-label="Page sketch overlay"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
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
      <div className="ft-page-sticker-layer">
        {stickers.map((item) => (
          <button
            key={item.id}
            className="ft-page-sticker"
            style={{
              left: item.x,
              top: item.y,
              fontSize: item.size
            }}
            onPointerDown={(event) => onStickerPointerDown(event, item)}
            onPointerMove={onStickerPointerMove}
            onPointerUp={stopStickerDrag}
            onPointerCancel={stopStickerDrag}
            type="button"
            aria-label={`Move sticker ${item.value}`}
          >
            {item.value}
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
});

export default PageSketchOverlay;
