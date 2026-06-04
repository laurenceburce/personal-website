"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const LENS_SIZE = 192;
const MAX_OUTPUT_DPR = 1.5;
const ZOOM_PRESETS = [0.25, 0.5, 1.5, 2, 3];
const SKETCH_CHANGED_EVENT = "floating-toolbar:sketch-changed";
const FLOATING_UI_SELECTOR = ".ft-window,.ft-menu,.ft-circle,.ft-click-bubble";
const UI_SYNC_INTERVAL_MS = 100;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const formatZoom = (value) => Number.isInteger(value) ? value : value.toFixed(2).replace(/0$/, "");

export default function Magnifier({ initialPointer = null }) {
  const [zoom, setZoom] = useState(2);
  const [portalReady, setPortalReady] = useState(false);
  const lensRef = useRef(null);
  const frameRef = useRef(null);
  const iframeRef = useRef(null);
  const sketchCanvasRef = useRef(null);
  const uiLayerRef = useRef(null);
  const renderFrameRef = useRef(null);
  const initialPointerAppliedRef = useRef(false);
  const lastUiSyncRef = useRef(0);
  const pointerRef = useRef({ clientX: 0, clientY: 0, visible: false });
  const zoomRef = useRef(zoom);

  const syncIframeScroll = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.scrollTo(window.scrollX, window.scrollY);
    } catch {}
  }, []);

  const syncFloatingUiLayer = useCallback((force = false) => {
    const layer = uiLayerRef.current;

    if (!layer) return;

    const now = performance.now();
    if (!force && now - lastUiSyncRef.current < UI_SYNC_INTERVAL_MS) return;

    lastUiSyncRef.current = now;

    const fragment = document.createDocumentFragment();
    const nodes = [...document.querySelectorAll(FLOATING_UI_SELECTOR)]
      .filter((node) => !node.closest(".ft-mag-lens"))
      .sort((a, b) => {
        const zA = Number.parseInt(window.getComputedStyle(a).zIndex, 10) || 0;
        const zB = Number.parseInt(window.getComputedStyle(b).zIndex, 10) || 0;
        return zA - zB;
      });

    nodes.forEach((node) => {
      const rect = node.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) return;

      const clone = node.cloneNode(true);
      const computed = window.getComputedStyle(node);

      clone.setAttribute("aria-hidden", "true");
      clone.querySelectorAll("[id]").forEach((child) => child.removeAttribute("id"));
      clone.style.position = "absolute";
      clone.style.left = `${rect.left}px`;
      clone.style.top = `${rect.top}px`;
      clone.style.right = "auto";
      clone.style.bottom = "auto";
      clone.style.width = `${rect.width}px`;
      clone.style.height = `${rect.height}px`;
      clone.style.margin = "0";
      clone.style.pointerEvents = "none";
      clone.style.transform = "none";
      clone.style.animation = "none";
      clone.style.zIndex = computed.zIndex === "auto" ? "0" : computed.zIndex;

      fragment.appendChild(clone);
    });

    layer.replaceChildren(fragment);
  }, []);

  const drawSketchLayer = useCallback(() => {
    const canvas = sketchCanvasRef.current;
    const pointer = pointerRef.current;
    const sketchCanvas = document.querySelector(".ft-page-sketch-canvas");

    if (!canvas || !pointer.visible) return;

    const outputDpr = Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_DPR);
    const outputSize = Math.round(LENS_SIZE * outputDpr);

    if (canvas.width !== outputSize || canvas.height !== outputSize) {
      canvas.width = outputSize;
      canvas.height = outputSize;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (sketchCanvas?.dataset.hasDrawing !== "true") return;

    const sketchWidth = Number.parseFloat(sketchCanvas.style.width) || document.documentElement.scrollWidth;
    const sketchHeight = Number.parseFloat(sketchCanvas.style.height) || document.documentElement.scrollHeight;

    if (sketchWidth <= 0 || sketchHeight <= 0 || sketchCanvas.width <= 0 || sketchCanvas.height <= 0) {
      return;
    }

    const zoomValue = zoomRef.current;
    const sourceWidth = LENS_SIZE / zoomValue;
    const sourceHeight = LENS_SIZE / zoomValue;
    const pageX = pointer.clientX + window.scrollX;
    const pageY = pointer.clientY + window.scrollY;
    const sourceX = clamp(pageX - sourceWidth / 2, 0, Math.max(0, sketchWidth - sourceWidth));
    const sourceY = clamp(pageY - sourceHeight / 2, 0, Math.max(0, sketchHeight - sourceHeight));
    const sketchScaleX = sketchCanvas.width / sketchWidth;
    const sketchScaleY = sketchCanvas.height / sketchHeight;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(
      sketchCanvas,
      sourceX * sketchScaleX,
      sourceY * sketchScaleY,
      sourceWidth * sketchScaleX,
      sourceHeight * sketchScaleY,
      0,
      0,
      canvas.width,
      canvas.height
    );
  }, []);

  const renderLens = useCallback(() => {
    const lens = lensRef.current;
    const frame = frameRef.current;
    const uiLayer = uiLayerRef.current;
    const pointer = pointerRef.current;

    if (!lens || !frame || !uiLayer || !pointer.visible) return;

    const lensX = pointer.clientX - LENS_SIZE / 2;
    const lensY = pointer.clientY - LENS_SIZE / 2;
    const zoomValue = zoomRef.current;

    lens.style.transform = `translate3d(${lensX}px, ${lensY}px, 0)`;
    lens.style.opacity = "1";

    frame.style.left = `${-lensX}px`;
    frame.style.top = `${-lensY}px`;
    frame.style.transformOrigin = `${pointer.clientX}px ${pointer.clientY}px`;
    frame.style.transform = `scale(${zoomValue})`;

    syncFloatingUiLayer();
    uiLayer.style.left = `${-lensX}px`;
    uiLayer.style.top = `${-lensY}px`;
    uiLayer.style.transformOrigin = `${pointer.clientX}px ${pointer.clientY}px`;
    uiLayer.style.transform = `scale(${zoomValue})`;

    drawSketchLayer();
  }, [drawSketchLayer, syncFloatingUiLayer]);

  const requestRender = useCallback(() => {
    if (renderFrameRef.current) return;

    renderFrameRef.current = window.requestAnimationFrame(() => {
      renderFrameRef.current = null;
      renderLens();
    });
  }, [renderLens]);

  const showLensAt = useCallback((clientX, clientY) => {
    pointerRef.current = { clientX, clientY, visible: true };
    requestRender();
  }, [requestRender]);

  const setZoomByDirection = (direction) => {
    setZoom((value) => {
      const currentIndex = ZOOM_PRESETS.indexOf(value);
      const closestIndex = ZOOM_PRESETS.reduce((bestIndex, preset, index) => (
        Math.abs(preset - value) < Math.abs(ZOOM_PRESETS[bestIndex] - value)
          ? index
          : bestIndex
      ), 0);
      const nextIndex = clamp(
        (currentIndex === -1 ? closestIndex : currentIndex) + direction,
        0,
        ZOOM_PRESETS.length - 1
      );

      return ZOOM_PRESETS[nextIndex];
    });
  };

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    if (!portalReady || initialPointerAppliedRef.current) return;

    initialPointerAppliedRef.current = true;
    const clientX = Number.isFinite(initialPointer?.clientX)
      ? initialPointer.clientX
      : window.innerWidth / 2;
    const clientY = Number.isFinite(initialPointer?.clientY)
      ? initialPointer.clientY
      : window.innerHeight / 2;

    syncIframeScroll();
    showLensAt(
      clamp(clientX, 0, window.innerWidth),
      clamp(clientY, 0, window.innerHeight)
    );
  }, [initialPointer, portalReady, showLensAt, syncIframeScroll]);

  useEffect(() => {
    if (!portalReady) return;

    const onPointerMove = (event) => showLensAt(event.clientX, event.clientY);
    const onPointerLeave = () => {
      pointerRef.current.visible = false;

      if (lensRef.current) {
        lensRef.current.style.opacity = "0";
      }
    };
    const onViewportChange = () => {
      syncIframeScroll();
      syncFloatingUiLayer(true);
      requestRender();
    };
    const onUiChange = () => {
      syncFloatingUiLayer(true);
      requestRender();
    };

    window.addEventListener("pointerdown", onPointerMove, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onUiChange, true);
    window.addEventListener("click", onUiChange, true);
    window.addEventListener("keyup", onUiChange);
    window.addEventListener("mouseleave", onPointerLeave);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, { passive: true });
    window.addEventListener(SKETCH_CHANGED_EVENT, requestRender);

    let uiObserver = null;
    if ("MutationObserver" in window && document.body) {
      uiObserver = new MutationObserver((mutations) => {
        const changedFloatingUi = mutations.some((mutation) => {
          if (mutation.target.closest?.(".ft-mag-lens")) return false;

          const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
          const changedNodes = nodes.some((node) => (
            node.nodeType === 1 &&
            !node.closest?.(".ft-mag-lens") &&
            (node.matches?.(FLOATING_UI_SELECTOR) || node.querySelector?.(FLOATING_UI_SELECTOR))
          ));

          return mutation.target.closest?.(FLOATING_UI_SELECTOR) || changedNodes;
        });

        if (changedFloatingUi) {
          onUiChange();
        }
      });

      uiObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ["class", "style", "aria-expanded", "aria-pressed"],
        characterData: true,
        childList: true,
        subtree: true
      });
    }

    return () => {
      window.removeEventListener("pointerdown", onPointerMove, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onUiChange, true);
      window.removeEventListener("click", onUiChange, true);
      window.removeEventListener("keyup", onUiChange);
      window.removeEventListener("mouseleave", onPointerLeave);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange);
      window.removeEventListener(SKETCH_CHANGED_EVENT, requestRender);
      uiObserver?.disconnect();

      if (renderFrameRef.current) {
        window.cancelAnimationFrame(renderFrameRef.current);
      }
    };
  }, [portalReady, requestRender, showLensAt, syncFloatingUiLayer, syncIframeScroll]);

  useEffect(() => {
    zoomRef.current = zoom;
    requestRender();
  }, [requestRender, zoom]);

  const lens = portalReady
    ? createPortal(
      <div ref={lensRef} className="ft-mag-lens" aria-hidden="true">
        <div ref={frameRef} className="ft-mag-frame">
          <iframe
            ref={iframeRef}
            src="/"
            className="ft-mag-iframe"
            onLoad={() => {
              syncIframeScroll();
              requestRender();
            }}
            tabIndex={-1}
            title="Magnifier view"
          />
        </div>
        <canvas ref={sketchCanvasRef} className="ft-mag-canvas" />
        <div ref={uiLayerRef} className="ft-mag-ui-layer" />
      </div>,
      document.body
    )
    : null;

  return (
    <>
      {lens}

      <div className="ft-magnifier">
        <div className="ft-mag-head">
          <span className="ft-mag-label">Zoom</span>
          <span className="ft-mag-val">{formatZoom(zoom)}x</span>
        </div>
        <div className="ft-mag-row">
          <button className="ft-mag-btn" onClick={() => setZoomByDirection(-1)} type="button">
            -
          </button>
          <input
            type="range"
            min="0"
            max={ZOOM_PRESETS.length - 1}
            step="1"
            value={ZOOM_PRESETS.indexOf(zoom)}
            onChange={(event) => setZoom(ZOOM_PRESETS[Number(event.target.value)])}
            className="ft-range"
          />
          <button className="ft-mag-btn" onClick={() => setZoomByDirection(1)} type="button">
            +
          </button>
        </div>
        <div className="ft-mag-presets">
          {ZOOM_PRESETS.map((preset) => (
            <button
              key={preset}
              className={`ft-mag-preset${zoom === preset ? " active" : ""}`}
              onClick={() => setZoom(preset)}
              type="button"
            >
              {formatZoom(preset)}x
            </button>
          ))}
        </div>
        <p className="ft-mag-hint">Move cursor over the page to magnify</p>
      </div>
    </>
  );
}
