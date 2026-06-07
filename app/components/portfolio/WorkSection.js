"use client";
import { animate, AnimatePresence, motion, useMotionValue, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import formatDurationFromPeriod from "../../utils/formatDurationFromPeriod";

const MAGNIFIER_WORK_SELECTION_KEY = "portfolio:magnifier:selected-work";
const WORK_SELECTION_MESSAGE = "portfolio:work-selection";
const WORK_SELECTION_CHANGED_EVENT = "portfolio:work-selection-changed";

const SCROLL_SPEED = 35; // px/s

const isMagnifierFrame = () => {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.self !== window.top &&
      new URLSearchParams(window.location.search).get("magnifier") === "1"
    );
  } catch {
    return false;
  }
};

const parseSelectedWork = (value, entryCount) => {
  if (value === null || value === undefined || value === "") return null;
  const next = Number(value);
  return Number.isInteger(next) && next >= 0 && next < entryCount ? next : null;
};

/* Derive a recency badge from the period string and card position */
const getRecencyBadge = (period, index) => {
  if (/present/i.test(period)) {
    const start = period.split(/\s*[-–]\s*/)[0]?.trim() || "";
    return { text: start ? `${start} – Now` : "Current", variant: "current" };
  }
  const years = (period.match(/\d{4}/g) || []);
  const start = years[0];
  const end   = years[years.length - 1];
  const text  = start && end && start !== end ? `${start} – ${end}` : end || "Past";
  return { text, variant: index === 1 ? "past" : "earlier" };
};

const CARD_SPRING   = { type: "spring", stiffness: 280, damping: 22 };
const TAP_SPRING    = { type: "spring", stiffness: 420, damping: 26 };
const DIM_TRANS     = { duration: 0.28, ease: [0.4, 0, 0.2, 1] };
const CENTER_SPRING = { type: "spring", stiffness: 180, damping: 28 };

const detailVariants = {
  hidden:  { opacity: 0, y: 22, scale: 0.96 },
  visible: { opacity: 1, y: 0, scale: 1,
    transition: { duration: 0.42, ease: [0.16, 1, 0.3, 1], staggerChildren: 0.07 } },
  exit:    { opacity: 0, y: 14, scale: 0.97,
    transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } },
};
const rowVariants = {
  hidden:  { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.36, ease: [0.16, 1, 0.3, 1] } },
};

export default function WorkSection({ timeline }) {
  const [selected, setSelected] = useState(null);
  const shouldReduceMotion = useReducedMotion();

  const x = useMotionValue(0);

  const outerRef    = useRef(null);
  const trackRef    = useRef(null);
  const firstSetRef = useRef(null);
  const setWidthRef = useRef(0);
  const pausedRef   = useRef(false);
  const hoveredRef  = useRef(false);
  const draggingRef = useRef(false);
  const selectedRef = useRef(null);

  useEffect(() => { selectedRef.current = selected; }, [selected]);

  /* Measure set width — useEffect (not useLayoutEffect) to avoid SSR hydration mismatch */
  const measureSetWidth = useCallback(() => {
    if (trackRef.current) {
      setWidthRef.current = trackRef.current.offsetWidth / 2;
    }
  }, []);

  useEffect(() => {
    measureSetWidth();
    window.addEventListener("resize", measureSetWidth, { passive: true });
    return () => window.removeEventListener("resize", measureSetWidth);
  }, [measureSetWidth]);

  /* ── RAF scroll loop ───────────────────────────────────────────────── */
  useEffect(() => {
    if (shouldReduceMotion) return;
    let last = 0;
    let rafId;
    const tick = (ts) => {
      rafId = requestAnimationFrame(tick);
      if (!last) { last = ts; return; }
      const dt = Math.min(ts - last, 50) / 1000;
      last = ts;
      if (pausedRef.current) return;
      const sw = setWidthRef.current;
      if (sw <= 0) return;
      let nx = x.get() - SCROLL_SPEED * dt;
      if (nx <= -sw) nx += sw;
      x.set(nx);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [x, shouldReduceMotion]);

  /* ── Pause helpers ─────────────────────────────────────────────────── */
  const setPaused = (val) => { pausedRef.current = val; };

  const tryResume = () => {
    if (!hoveredRef.current && !draggingRef.current && selectedRef.current === null) {
      setPaused(false);
    }
  };

  const handleMouseEnter = () => { hoveredRef.current = true;  setPaused(true); };
  const handleMouseLeave = () => { hoveredRef.current = false; tryResume(); };

  /* ── Drag / swipe via raw pointer events on the outer container ─────
   *  Registering on the outer div (not the track) means pointer-down on
   *  any child card reliably reaches us. setPointerCapture keeps tracking
   *  even when the pointer moves outside the element.
   * ─────────────────────────────────────────────────────────────────── */
  const lastPtrXRef = useRef(0);
  const dragDistRef = useRef(0); // accumulates total horizontal travel

  const handlePointerDown = (e) => {
    // Ignore non-primary buttons on mouse (right-click etc.)
    if (e.pointerType === "mouse" && e.button !== 0) return;
    draggingRef.current = true;
    lastPtrXRef.current = e.clientX;
    dragDistRef.current = 0;
    setPaused(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e) => {
    if (!draggingRef.current) return;
    const delta = e.clientX - lastPtrXRef.current;
    lastPtrXRef.current = e.clientX;
    dragDistRef.current += Math.abs(delta);
    const sw = setWidthRef.current;
    if (sw <= 0) return;
    let nx = x.get() + delta;
    // Wrap x into [-sw, 0) so the loop stays seamless
    while (nx < -sw) nx += sw;
    while (nx >= 0)  nx -= sw;
    x.set(nx);
  };

  const handlePointerUp = () => {
    draggingRef.current = false;
    tryResume();
  };

  // After a real drag, prevent the synthetic click that fires on pointer-up
  const handleClickCapture = (e) => {
    if (dragDistRef.current > 5) e.stopPropagation();
  };

  /* ── Center selected card — springs to the nearest instance ────────── */
  useEffect(() => {
    if (selected === null) { tryResume(); return; }
    setPaused(true);

    const cards = firstSetRef.current?.children;
    const container = outerRef.current;
    if (!cards || !container || !cards[selected]) return;

    const card = cards[selected];
    const gap = (container.offsetWidth - card.offsetWidth) / 2;
    const set1X = card.offsetLeft;
    const sw    = setWidthRef.current;

    let targetX;
    if (sw > 0) {
      const set2X  = sw + set1X;
      const tX1    = -(set1X - gap);
      const tX2    = -(set2X - gap);
      const cur    = x.get();
      targetX = Math.abs(tX1 - cur) <= Math.abs(tX2 - cur) ? tX1 : tX2;
    } else {
      targetX = -(set1X - gap);
    }

    animate(x, targetX, CENTER_SPRING);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  /* ── Card selection ─────────────────────────────────────────────────── */
  const handleSelect = (i) => setSelected((prev) => (prev === i ? null : i));

  /* ── Magnifier sync ─────────────────────────────────────────────────── */
  useEffect(() => {
    if (!isMagnifierFrame()) return;
    try {
      const stored = parseSelectedWork(
        window.localStorage.getItem(MAGNIFIER_WORK_SELECTION_KEY),
        timeline.length
      );
      if (stored !== null) setSelected(stored);
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isMagnifierFrame()) return;
    try {
      if (selected === null) {
        window.localStorage.removeItem(MAGNIFIER_WORK_SELECTION_KEY);
      } else {
        window.localStorage.setItem(MAGNIFIER_WORK_SELECTION_KEY, String(selected));
      }
      window.dispatchEvent(new CustomEvent(WORK_SELECTION_CHANGED_EVENT, { detail: { selected } }));
    } catch {}
  }, [selected]);

  useEffect(() => {
    if (!isMagnifierFrame()) return undefined;
    const apply = (v) => setSelected(parseSelectedWork(v, timeline.length));
    const onStorage = (e) => { if (e.key === MAGNIFIER_WORK_SELECTION_KEY) apply(e.newValue); };
    const onMessage = (e) => { if (e.data?.type === WORK_SELECTION_MESSAGE) apply(e.data.selected); };
    window.addEventListener("storage", onStorage);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("message", onMessage);
    };
  }, [timeline.length]);

  const selectedEntry = selected !== null ? timeline[selected] : null;
  const anySelected   = selected !== null;

  /* Shared card renderer — used for both set 1 (interactive) and set 2 (visual duplicate) */
  const renderCard = (entry, i, setIdx) => {
    const isActive  = selected === i;
    const isDimmed  = anySelected && !isActive;
    const isPrimary = setIdx === 0;
    const badge     = getRecencyBadge(entry.period, i);
    return (
      <motion.div
        key={isPrimary ? entry.company : `dup-${entry.company}`}
        role={isPrimary ? "button" : "presentation"}
        tabIndex={isPrimary ? 0 : -1}
        aria-hidden={isPrimary ? undefined : "true"}
        className={`work-card${isActive ? " work-card--active" : ""}${isDimmed ? " work-card--dimmed" : ""}`}
        onClick={() => handleSelect(i)}
        onKeyDown={(e) => {
          if (!isPrimary) return;
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSelect(i); }
        }}
        aria-expanded={isPrimary ? isActive : undefined}
        animate={shouldReduceMotion ? {} : {
          scale:   isActive ? 1.015 : isDimmed ? 0.965 : 1,
          opacity: isDimmed ? 0.52 : 1,
          transition: isActive || isDimmed ? DIM_TRANS : CARD_SPRING,
        }}
        whileHover={!shouldReduceMotion && !isActive
          ? { y: -8, scale: isDimmed ? 1 : 1.02, transition: CARD_SPRING } : {}}
        whileTap={!shouldReduceMotion
          ? { scale: 0.96, y: 0, transition: TAP_SPRING } : {}}
      >
        {/* Recency badge — top-left corner */}
        <span className={`work-card-recency work-card-recency--${badge.variant}`} aria-label={isPrimary ? badge.text : undefined}>
          <span className="work-card-recency-dot" aria-hidden="true" />
          {badge.text}
        </span>

        <span className={`work-card-logo brand-mark brand-mark-${entry.logoClass}`}>
          <img src={entry.logoUrl} alt={isPrimary ? entry.company : ""} loading="lazy" />
        </span>
        <div className="work-card-info">
          <span className="work-card-company">{entry.company}</span>
          <span className="work-card-role">
            {entry.roles[0].title}
            {entry.roles.length > 1 && (
              <span className="work-card-more">
                +{entry.roles.length - 1} role{entry.roles.length - 1 > 1 ? "s" : ""}
              </span>
            )}
          </span>
          <span className="work-card-meta">{entry.location}</span>
          <span className="work-card-duration">{formatDurationFromPeriod(entry.period)}</span>
        </div>
        <a
          href={entry.website}
          target="_blank"
          rel="noreferrer"
          className="work-card-site"
          aria-label={isPrimary ? `${entry.company} Website` : undefined}
          tabIndex={isPrimary ? undefined : -1}
          onClick={(e) => e.stopPropagation()}
        >
          Website
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            style={{ marginLeft: "0.2em", flexShrink: 0 }}>
            <path d="M2 8 8 2M8 2H4M8 2v4" />
          </svg>
        </a>
        <svg className="work-card-chevron" width="14" height="14" viewBox="0 0 14 14"
          fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points={isActive ? "2 9 7 4 12 9" : "2 5 7 10 12 5"} />
        </svg>
      </motion.div>
    );
  };

  return (
    <section id="work" className="section reveal">
      <div className="section-head">
        <h2>Work Experience</h2>
      </div>
      <div className="work-list">

        <div
          ref={outerRef}
          className="work-carousel-wrap carousel-marquee-outer"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onClickCapture={handleClickCapture}
        >
          <div className="work-fade work-fade--left"  aria-hidden="true" />
          <div className="work-fade work-fade--right" aria-hidden="true" />

          <motion.div
            ref={trackRef}
            className="carousel-marquee-track"
            style={{ x }}
          >
            {/* Set 1 — primary, fully accessible */}
            <div ref={firstSetRef} className="carousel-marquee-set">
              {timeline.map((entry, i) => renderCard(entry, i, 0))}
            </div>

            {/* Set 2 — visual duplicate for seamless loop, mouse-interactive but screen-reader hidden */}
            <div className="carousel-marquee-set" aria-hidden="true">
              {timeline.map((entry, i) => renderCard(entry, i, 1))}
            </div>
          </motion.div>
        </div>

        <AnimatePresence mode="wait">
          {selectedEntry && (
            <motion.div key={selectedEntry.company} className="work-detail"
              variants={detailVariants} initial="hidden" animate="visible" exit="exit">
              <motion.div variants={rowVariants} className="work-detail-header">
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.8rem", flexWrap: "wrap" }}>
                  <h3 className="work-detail-company">{selectedEntry.company}</h3>
                  <span className="work-detail-period-pill">{formatDurationFromPeriod(selectedEntry.period)}</span>
                </div>
              </motion.div>
              <motion.div variants={rowVariants} className="work-role-timeline">
                {selectedEntry.roles.map((role) => (
                  <motion.div key={role.title} variants={rowVariants} className="work-role-entry">
                    <div className="work-role-entry-head">
                      <h4>{role.title}</h4>
                      <time>{role.period}</time>
                    </div>
                    {Array.isArray(role.summary) ? (
                      <ul className="timeline-bullets">
                        {role.summary.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    ) : (
                      <p style={{ marginTop: "0.2rem", fontSize: "0.93rem", lineHeight: "1.68" }}>{role.summary}</p>
                    )}
                  </motion.div>
                ))}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
