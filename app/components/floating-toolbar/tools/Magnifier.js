"use client";

import { useEffect, useRef, useState } from "react";

const LENS_SIZE = 192;

export default function Magnifier() {
  const [zoom, setZoom] = useState(2);
  const lensRef = useRef(null);
  const innerRef = useRef(null);
  const iframeRef = useRef(null);

  useEffect(() => {
    const lens = lensRef.current;
    const inner = innerRef.current;
    if (!lens || !inner) return;

    const update = (clientX, clientY) => {
      lens.style.left = `${clientX - LENS_SIZE / 2}px`;
      lens.style.top = `${clientY - LENS_SIZE / 2}px`;
      lens.style.opacity = "1";
      inner.style.left = `${-(clientX - LENS_SIZE / 2)}px`;
      inner.style.top = `${-(clientY - LENS_SIZE / 2)}px`;
      inner.style.transformOrigin = `${clientX}px ${clientY}px`;
    };

    const onMove = (event) => update(event.clientX, event.clientY);
    const onTouch = (event) => {
      event.preventDefault();
      update(event.touches[0].clientX, event.touches[0].clientY);
    };
    const onLeave = () => {
      lens.style.opacity = "0";
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchmove", onTouch, { passive: false });
    window.addEventListener("mouseleave", onLeave);

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onTouch);
      window.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  useEffect(() => {
    const sync = () => {
      try {
        iframeRef.current?.contentWindow?.scrollTo(0, window.scrollY);
      } catch {}
    };

    window.addEventListener("scroll", sync, { passive: true });
    return () => window.removeEventListener("scroll", sync);
  }, []);

  const onIframeLoad = () => {
    try {
      iframeRef.current?.contentWindow?.scrollTo(0, window.scrollY);
    } catch {}
  };

  return (
    <>
      <div ref={lensRef} className="ft-mag-lens" style={{ opacity: 0 }} aria-hidden="true">
        <div
          ref={innerRef}
          className="ft-mag-inner"
          style={{ transform: `scale(${zoom})` }}
        >
          <iframe
            ref={iframeRef}
            src="/"
            className="ft-mag-iframe"
            tabIndex={-1}
            onLoad={onIframeLoad}
            title="Magnifier lens"
          />
        </div>
      </div>

      <div className="ft-magnifier">
        <div className="ft-mag-head">
          <span className="ft-mag-label">Zoom</span>
          <span className="ft-mag-val">{zoom}×</span>
        </div>
        <div className="ft-mag-row">
          <button
            className="ft-mag-btn"
            onClick={() => setZoom((value) => Math.max(1.5, parseFloat((value - 0.5).toFixed(1))))}
            type="button"
          >
            −
          </button>
          <input
            type="range"
            min="1.5"
            max="4"
            step="0.5"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            className="ft-range"
          />
          <button
            className="ft-mag-btn"
            onClick={() => setZoom((value) => Math.min(4, parseFloat((value + 0.5).toFixed(1))))}
            type="button"
          >
            +
          </button>
        </div>
        <div className="ft-mag-presets">
          {[1.5, 2, 3, 4].map((preset) => (
            <button
              key={preset}
              className={`ft-mag-preset${zoom === preset ? " active" : ""}`}
              onClick={() => setZoom(preset)}
              type="button"
            >
              {preset}×
            </button>
          ))}
        </div>
        <p className="ft-mag-hint">Move cursor over the page to magnify</p>
      </div>
    </>
  );
}
