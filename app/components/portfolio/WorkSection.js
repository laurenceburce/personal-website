"use client";
import { useEffect, useRef, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import formatDurationFromPeriod from "../../utils/formatDurationFromPeriod";

const MAGNIFIER_WORK_SELECTION_KEY = "portfolio:magnifier:selected-work";
const WORK_SELECTION_MESSAGE = "portfolio:work-selection";
const WORK_SELECTION_CHANGED_EVENT = "portfolio:work-selection-changed";

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

const CARD_SPRING   = { type: "spring", stiffness: 300, damping: 20 };
const TAP_SPRING    = { type: "spring", stiffness: 420, damping: 26 };
const ARROW_SPRING  = { type: "spring", stiffness: 420, damping: 22 };
const DETAIL_EASE   = { duration: 0.32, ease: [0.16, 1, 0.3, 1] };

export default function WorkSection({ timeline }) {
  // Always start with null so server and client render identical HTML.
  // The magnifier iframe reads its initial selection from localStorage
  // after mount (in a useEffect), avoiding the hydration mismatch that
  // would occur if we read window.localStorage during the lazy initializer.
  const [selected, setSelected] = useState(null);
  const [canScrollPrev, setCanScrollPrev] = useState(false);
  const [canScrollNext, setCanScrollNext] = useState(false);
  const shouldReduceMotion = useReducedMotion();

  const [emblaRef, emblaApi] = useEmblaCarousel({
    align: "start",
    dragFree: true,
    containScroll: "trimSnaps",
  });

  useEffect(() => {
    if (!emblaApi) return;
    const onUpdate = () => {
      setCanScrollPrev(emblaApi.canScrollPrev());
      setCanScrollNext(emblaApi.canScrollNext());
    };
    emblaApi.on("scroll",  onUpdate);
    emblaApi.on("select",  onUpdate);
    emblaApi.on("reInit",  onUpdate);
    onUpdate();
    return () => {
      emblaApi.off("scroll",  onUpdate);
      emblaApi.off("select",  onUpdate);
      emblaApi.off("reInit",  onUpdate);
    };
  }, [emblaApi]);

  // Load initial selection from localStorage once on mount (magnifier iframes only).
  // Must be a useEffect — not a useState initializer — so the server and client
  // both start with selected=null and produce matching HTML before hydration.
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

  // Sync selection back to localStorage so the magnifier can reflect main-page state
  useEffect(() => {
    if (isMagnifierFrame()) return;
    try {
      if (selected === null) {
        window.localStorage.removeItem(MAGNIFIER_WORK_SELECTION_KEY);
      } else {
        window.localStorage.setItem(MAGNIFIER_WORK_SELECTION_KEY, String(selected));
      }
      window.dispatchEvent(
        new CustomEvent(WORK_SELECTION_CHANGED_EVENT, { detail: { selected } })
      );
    } catch {}
  }, [selected]);

  useEffect(() => {
    if (!isMagnifierFrame()) return undefined;
    const applySelection = (value) =>
      setSelected(parseSelectedWork(value, timeline.length));
    const onStorage = (e) => {
      if (e.key === MAGNIFIER_WORK_SELECTION_KEY) applySelection(e.newValue);
    };
    const onMessage = (e) => {
      if (e.data?.type === WORK_SELECTION_MESSAGE) applySelection(e.data.selected);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("message", onMessage);
    };
  }, [timeline.length]);

  const handleSelect = (i) => setSelected(selected === i ? null : i);
  const selectedEntry = selected !== null ? timeline[selected] : null;

  return (
    <section id="work" className="section reveal">
      <div className="section-head">
        <h2>Work Experience</h2>
      </div>
      <div className="work-list">
        <div className="work-carousel-wrap">
          {canScrollPrev && (
            <div className="work-fade work-fade--left" aria-hidden="true" />
          )}
          {canScrollNext && (
            <div className="work-fade work-fade--right" aria-hidden="true" />
          )}

          {/* Embla viewport — owns drag/overflow */}
          <div ref={emblaRef} className="embla-viewport">
            <div className="work-cards-row">
              {timeline.map((entry, i) => {
                const isActive = selected === i;
                return (
                  <motion.div
                    key={entry.company}
                    role="button"
                    tabIndex={0}
                    className={`work-card${isActive ? " work-card--active" : ""}`}
                    onClick={() => handleSelect(i)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleSelect(i);
                      }
                    }}
                    aria-expanded={isActive}
                    /* Active card sinks slightly to show it's pressed */
                    animate={
                      shouldReduceMotion ? {} : { y: isActive ? 2 : 0 }
                    }
                    whileHover={
                      !shouldReduceMotion && !isActive
                        ? { y: -5, transition: CARD_SPRING }
                        : {}
                    }
                    whileTap={
                      !shouldReduceMotion
                        ? { scale: 0.96, y: 0, transition: TAP_SPRING }
                        : {}
                    }
                    transition={CARD_SPRING}
                  >
                    <span
                      className={`work-card-logo brand-mark brand-mark-${entry.logoClass}`}
                    >
                      <img
                        src={entry.logoUrl}
                        alt={entry.company}
                        loading="lazy"
                      />
                    </span>
                    <div className="work-card-info">
                      <span className="work-card-company">{entry.company}</span>
                      <span className="work-card-role">
                        {entry.roles[0].title}
                        {entry.roles.length > 1 && (
                          <span className="work-card-more">
                            +{entry.roles.length - 1} role
                            {entry.roles.length - 1 > 1 ? "s" : ""}
                          </span>
                        )}
                      </span>
                      <span className="work-card-meta">{entry.location}</span>
                      <span className="work-card-duration">
                        {formatDurationFromPeriod(entry.period)}
                      </span>
                    </div>
                    <a
                      href={entry.website}
                      target="_blank"
                      rel="noreferrer"
                      className="work-card-site"
                      aria-label={`${entry.company} Website`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      Website
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginLeft: "0.2em", flexShrink: 0 }}>
                      <path d="M2 8 8 2M8 2H4M8 2v4" />
                    </svg>
                    </a>
                    <svg
                      className="work-card-chevron"
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline
                        points={isActive ? "2 9 7 4 12 9" : "2 5 7 10 12 5"}
                      />
                    </svg>
                  </motion.div>
                );
              })}
            </div>
          </div>

          {/* Navigation arrows */}
          <div className="carousel-arrows">
            <motion.button
              className="carousel-arrow"
              onClick={() => emblaApi?.scrollPrev()}
              disabled={!canScrollPrev}
              aria-label="Scroll to previous company"
              whileHover={!shouldReduceMotion ? { scale: 1.12 } : {}}
              whileTap={!shouldReduceMotion ? { scale: 0.88 } : {}}
              transition={ARROW_SPRING}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="9 2 5 7 9 12" />
              </svg>
            </motion.button>
            <motion.button
              className="carousel-arrow"
              onClick={() => emblaApi?.scrollNext()}
              disabled={!canScrollNext}
              aria-label="Scroll to next company"
              whileHover={!shouldReduceMotion ? { scale: 1.12 } : {}}
              whileTap={!shouldReduceMotion ? { scale: 0.88 } : {}}
              transition={ARROW_SPRING}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="5 2 9 7 5 12" />
              </svg>
            </motion.button>
          </div>
        </div>

        {/* Detail panel with enter/exit animation */}
        <AnimatePresence mode="wait">
          {selectedEntry && (
            <motion.div
              key={selectedEntry.company}
              className="work-detail"
              initial={shouldReduceMotion ? false : { opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={shouldReduceMotion ? {} : { opacity: 0, y: -8 }}
              transition={DETAIL_EASE}
            >
              <div className="work-detail-header">
                <h3>{selectedEntry.company}</h3>
              </div>
              <div className="work-detail-roles">
                {selectedEntry.roles.map((role) => (
                  <div key={role.title} className="work-detail-role">
                    <div className="work-detail-role-head">
                      <h4>{role.title}</h4>
                      <time>{role.period}</time>
                    </div>
                    {Array.isArray(role.summary) ? (
                      <ul className="timeline-bullets">
                        {role.summary.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>{role.summary}</p>
                    )}
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
