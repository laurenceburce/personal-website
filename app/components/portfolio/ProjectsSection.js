"use client";

import { animate, AnimatePresence, motion, useMotionValue, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

const MAGNIFIER_PROJECT_SELECTION_KEY = "portfolio:magnifier:selected-project";
const PROJECT_SELECTION_MESSAGE = "portfolio:project-selection";
const PROJECT_SELECTION_CHANGED_EVENT = "portfolio:project-selection-changed";

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

const parseSelectedProject = (value, projectCount) => {
  if (value === null || value === undefined || value === "") return null;
  const next = Number(value);
  return Number.isInteger(next) && next >= 0 && next < projectCount ? next : null;
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

const TAG_CLASSES = ["detail-tag--cyan", "detail-tag--violet", "detail-tag--slate", "detail-tag--emerald"];

export default function ProjectsSection({ projects }) {
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
   *  No setPointerCapture: capture redirects the resulting click event to
   *  the outer div, preventing card onClick from ever firing. Touch is
   *  implicitly captured by the browser anyway. A global pointerup listener
   *  ensures dragging state resets if the pointer is released outside.
   * ─────────────────────────────────────────────────────────────────── */
  const lastPtrXRef = useRef(0);
  const dragDistRef = useRef(0);

  const handlePointerDown = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    draggingRef.current = true;
    lastPtrXRef.current = e.clientX;
    dragDistRef.current = 0;
    setPaused(true);
  };

  const handlePointerMove = (e) => {
    if (!draggingRef.current) return;
    const delta = e.clientX - lastPtrXRef.current;
    lastPtrXRef.current = e.clientX;
    dragDistRef.current += Math.abs(delta);
    const sw = setWidthRef.current;
    if (sw <= 0) return;
    let nx = x.get() + delta;
    while (nx < -sw) nx += sw;
    while (nx >= 0)  nx -= sw;
    x.set(nx);
  };

  const handlePointerUp = () => {
    draggingRef.current = false;
    tryResume();
  };

  // Suppress clicks after a real drag; threshold of 10px tolerates mobile touch jitter
  const handleClickCapture = (e) => {
    if (dragDistRef.current > 10) e.stopPropagation();
  };

  // Global fallback: reset drag state if pointer is released outside the element
  useEffect(() => {
    const onRelease = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      if (!hoveredRef.current && selectedRef.current === null) pausedRef.current = false;
    };
    window.addEventListener("pointerup", onRelease);
    window.addEventListener("pointercancel", onRelease);
    return () => {
      window.removeEventListener("pointerup", onRelease);
      window.removeEventListener("pointercancel", onRelease);
    };
  }, []);

  /* ── Center selected card — nearest instance ───────────────────────── */
  useEffect(() => {
    if (selected === null) { tryResume(); return; }
    setPaused(true);

    const cards = firstSetRef.current?.children;
    const container = outerRef.current;
    if (!cards || !container || !cards[selected]) return;

    const card = cards[selected];
    const gap  = (container.offsetWidth - card.offsetWidth) / 2;
    const set1X = card.offsetLeft;
    const sw    = setWidthRef.current;

    let targetX;
    if (sw > 0) {
      const set2X = sw + set1X;
      const tX1   = -(set1X - gap);
      const tX2   = -(set2X - gap);
      const cur   = x.get();
      targetX = Math.abs(tX1 - cur) <= Math.abs(tX2 - cur) ? tX1 : tX2;
    } else {
      targetX = -(set1X - gap);
    }

    animate(x, targetX, CENTER_SPRING);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const handleSelect = (i) => setSelected((prev) => (prev === i ? null : i));

  /* ── Magnifier sync ─────────────────────────────────────────────────── */
  useEffect(() => {
    if (!isMagnifierFrame()) return;
    try {
      const stored = parseSelectedProject(
        window.localStorage.getItem(MAGNIFIER_PROJECT_SELECTION_KEY),
        projects.length
      );
      if (stored !== null) setSelected(stored);
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isMagnifierFrame()) return;
    try {
      if (selected === null) {
        window.localStorage.removeItem(MAGNIFIER_PROJECT_SELECTION_KEY);
      } else {
        window.localStorage.setItem(MAGNIFIER_PROJECT_SELECTION_KEY, String(selected));
      }
      window.dispatchEvent(new CustomEvent(PROJECT_SELECTION_CHANGED_EVENT, { detail: { selected } }));
    } catch {}
  }, [selected]);

  useEffect(() => {
    if (!isMagnifierFrame()) return undefined;
    const apply = (v) => setSelected(parseSelectedProject(v, projects.length));
    const onStorage = (e) => { if (e.key === MAGNIFIER_PROJECT_SELECTION_KEY) apply(e.newValue); };
    const onMessage = (e) => { if (e.data?.type === PROJECT_SELECTION_MESSAGE) apply(e.data.selected); };
    window.addEventListener("storage", onStorage);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("message", onMessage);
    };
  }, [projects.length]);

  const selectedProject = selected !== null ? projects[selected] : null;
  const anySelected     = selected !== null;

  /* Shared card renderer — used for both set 1 (interactive) and set 2 (visual duplicate) */
  const renderCard = (project, i, setIdx) => {
    const isActive  = selected === i;
    const isDimmed  = anySelected && !isActive;
    const isPrimary = setIdx === 0;
    return (
      <motion.article
        key={isPrimary ? project.title : `dup-${project.title}`}
        role={isPrimary ? "button" : "presentation"}
        tabIndex={isPrimary ? 0 : -1}
        aria-hidden={isPrimary ? undefined : "true"}
        className={`work-card project-card${isActive ? " work-card--active project-card--active" : ""}${isDimmed ? " work-card--dimmed" : ""}`}
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
        <span className="project-card-watermark" aria-hidden="true">
          {String(i + 1).padStart(2, "0")}
        </span>
        <span className="project-card-index" style={{ position: "relative", zIndex: 1 }}>
          {String(i + 1).padStart(2, "0")}
        </span>
        <div className="work-card-info project-card-info" style={{ position: "relative", zIndex: 1 }}>
          <span className="project-card-kicker">{project.association || "Featured Project"}</span>
          <span className="work-card-company project-card-title">{project.title}</span>
          {(project.period || project.association) && (
            <span className="work-card-meta project-card-meta-line">
              {[project.period, project.association].filter(Boolean).map((item, j, arr) => (
                <span key={j}>
                  {item}
                  {j < arr.length - 1 && (
                    <svg width="3" height="3" viewBox="0 0 3 3" aria-hidden="true"
                      style={{ display: "inline-block", verticalAlign: "middle", margin: "0 4px", flexShrink: 0 }}>
                      <circle cx="1.5" cy="1.5" r="1.5" fill="currentColor" />
                    </svg>
                  )}
                </span>
              ))}
            </span>
          )}
          <div className="project-card-tech" aria-label={isPrimary ? `${project.title} technologies` : undefined}>
            {project.tech.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
          </div>
        </div>
        <div className="project-card-actions" style={{ position: "relative", zIndex: 1 }}>
          {project.link && (
            <a href={project.link} target="_blank" rel="noreferrer"
              className="work-card-site"
              aria-label={isPrimary ? `${project.title} Repository` : undefined}
              tabIndex={isPrimary ? undefined : -1}
              onClick={(e) => e.stopPropagation()}>
              Repository
            </a>
          )}
          {project.paper && (
            <a href={project.paper} target="_blank" rel="noreferrer"
              className="work-card-site"
              aria-label={isPrimary ? `${project.title} Research Paper` : undefined}
              tabIndex={isPrimary ? undefined : -1}
              onClick={(e) => e.stopPropagation()}>
              IEEE Paper
            </a>
          )}
          <span className="project-card-detail">View details</span>
        </div>
        <svg className="work-card-chevron" width="14" height="14" viewBox="0 0 14 14"
          fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points={isActive ? "2 9 7 4 12 9" : "2 5 7 10 12 5"} />
        </svg>
      </motion.article>
    );
  };

  return (
    <section id="projects" className="section reveal">
      <div className="section-head">
        <h2>Projects</h2>
        <p>
          Selected projects spanning portfolio UI, interactive web tools, and
          backend API development.
        </p>
      </div>
      <div className="project-list">

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
            <div ref={firstSetRef} className="carousel-marquee-set">
              {projects.map((project, i) => renderCard(project, i, 0))}
            </div>
            <div className="carousel-marquee-set" aria-hidden="true">
              {projects.map((project, i) => renderCard(project, i, 1))}
            </div>
          </motion.div>
        </div>

        <AnimatePresence mode="wait">
          {selectedProject && (
            <motion.div key={selectedProject.title} className="work-detail project-detail"
              variants={detailVariants} initial="hidden" animate="visible" exit="exit">
              <motion.div variants={rowVariants} className="project-detail-top">
                <span className="project-detail-num" aria-hidden="true">
                  {String(projects.indexOf(selectedProject) + 1).padStart(2, "0")}
                </span>
                <div className="project-detail-meta">
                  <h3 className="project-detail-title">{selectedProject.title}</h3>
                  {selectedProject.association && (
                    <span className="project-detail-assoc">{selectedProject.association}</span>
                  )}
                </div>
              </motion.div>
              <motion.div variants={rowVariants} className="project-detail-desc">
                <p>{selectedProject.description}</p>
              </motion.div>
              {selectedProject.tech.length > 0 && (
                <motion.div variants={rowVariants}
                  style={{ display: "flex", flexWrap: "wrap", gap: "0.44rem", marginBottom: "1.1rem" }}>
                  {selectedProject.tech.map((tag, idx) => (
                    <span key={tag} className={`detail-tag ${TAG_CLASSES[idx % TAG_CLASSES.length]}`}>{tag}</span>
                  ))}
                </motion.div>
              )}
              {(selectedProject.link || selectedProject.paper) && (
                <motion.div variants={rowVariants} style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem" }}>
                  {selectedProject.link && (
                    <a href={selectedProject.link} target="_blank" rel="noreferrer"
                      className="detail-cta detail-cta--repo" aria-label={`${selectedProject.title} Repository`}>
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                      </svg>
                      View Repository
                    </a>
                  )}
                  {selectedProject.paper && (
                    <a href={selectedProject.paper} target="_blank" rel="noreferrer"
                      className="detail-cta detail-cta--paper" aria-label={`${selectedProject.title} Research Paper`}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="16" y1="13" x2="8" y2="13" />
                        <line x1="16" y1="17" x2="8" y2="17" />
                        <polyline points="10 9 9 9 8 9" />
                      </svg>
                      IEEE Research Paper
                    </a>
                  )}
                </motion.div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
