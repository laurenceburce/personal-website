"use client";

import { useEffect, useRef, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

const MAGNIFIER_PROJECT_SELECTION_KEY = "portfolio:magnifier:selected-project";
const PROJECT_SELECTION_MESSAGE = "portfolio:project-selection";
const PROJECT_SELECTION_CHANGED_EVENT = "portfolio:project-selection-changed";

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

const CARD_SPRING  = { type: "spring", stiffness: 300, damping: 20 };
const TAP_SPRING   = { type: "spring", stiffness: 420, damping: 26 };
const ARROW_SPRING = { type: "spring", stiffness: 420, damping: 22 };
const DETAIL_EASE  = { duration: 0.32, ease: [0.16, 1, 0.3, 1] };

export default function ProjectsSection({ projects }) {
  // Always start with null — see WorkSection.js for the hydration-safety rationale.
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
        window.localStorage.setItem(
          MAGNIFIER_PROJECT_SELECTION_KEY,
          String(selected)
        );
      }
      window.dispatchEvent(
        new CustomEvent(PROJECT_SELECTION_CHANGED_EVENT, { detail: { selected } })
      );
    } catch {}
  }, [selected]);

  useEffect(() => {
    if (!isMagnifierFrame()) return undefined;
    const applySelection = (value) =>
      setSelected(parseSelectedProject(value, projects.length));
    const onStorage = (e) => {
      if (e.key === MAGNIFIER_PROJECT_SELECTION_KEY) applySelection(e.newValue);
    };
    const onMessage = (e) => {
      if (e.data?.type === PROJECT_SELECTION_MESSAGE) applySelection(e.data.selected);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("message", onMessage);
    };
  }, [projects.length]);

  const handleSelect = (i) => setSelected(selected === i ? null : i);
  const selectedProject = selected !== null ? projects[selected] : null;

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
        <div className="work-carousel-wrap">
          {canScrollPrev && (
            <div className="work-fade work-fade--left" aria-hidden="true" />
          )}
          {canScrollNext && (
            <div className="work-fade work-fade--right" aria-hidden="true" />
          )}

          {/* Embla viewport — owns drag/overflow */}
          <div ref={emblaRef} className="embla-viewport">
            <div className="work-cards-row project-cards-row">
              {projects.map((project, i) => {
                const isActive = selected === i;
                return (
                  <motion.article
                    key={project.title}
                    className={`work-card project-card${isActive ? " work-card--active project-card--active" : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelect(i)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleSelect(i);
                      }
                    }}
                    aria-expanded={isActive}
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
                    <span className="project-card-index">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div className="work-card-info project-card-info">
                      <span className="project-card-kicker">
                        {project.association || "Featured Project"}
                      </span>
                      <span className="work-card-company project-card-title">
                        {project.title}
                      </span>
                      {(project.period || project.association) && (
                        <span className="work-card-meta project-card-meta-line">
                          {[project.period, project.association]
                            .filter(Boolean)
                            .map((item, j, arr) => (
                              <span key={j}>
                                {item}
                                {j < arr.length - 1 && (
                                  <svg
                                    width="3"
                                    height="3"
                                    viewBox="0 0 3 3"
                                    aria-hidden="true"
                                    style={{
                                      display: "inline-block",
                                      verticalAlign: "middle",
                                      margin: "0 4px",
                                      flexShrink: 0,
                                    }}
                                  >
                                    <circle
                                      cx="1.5"
                                      cy="1.5"
                                      r="1.5"
                                      fill="currentColor"
                                    />
                                  </svg>
                                )}
                              </span>
                            ))}
                        </span>
                      )}
                      <div
                        className="project-card-tech"
                        aria-label={`${project.title} technologies`}
                      >
                        {project.tech.slice(0, 3).map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                    </div>
                    <div className="project-card-actions">
                      {project.link ? (
                        <a
                          href={project.link}
                          target="_blank"
                          rel="noreferrer"
                          className="work-card-site"
                          aria-label={`${project.title} Repository`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          Repository
                        </a>
                      ) : null}
                      {project.paper ? (
                        <a
                          href={project.paper}
                          target="_blank"
                          rel="noreferrer"
                          className="work-card-site"
                          aria-label={`${project.title} Research Paper`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          IEEE Paper
                        </a>
                      ) : null}
                      <span className="project-card-detail">View details</span>
                    </div>
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
                  </motion.article>
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
              aria-label="Scroll to previous project"
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
              aria-label="Scroll to next project"
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
          {selectedProject && (
            <motion.div
              key={selectedProject.title}
              className="work-detail project-detail"
              initial={shouldReduceMotion ? false : { opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={shouldReduceMotion ? {} : { opacity: 0, y: -8 }}
              transition={DETAIL_EASE}
            >
              <div className="work-detail-header">
                <h3>{selectedProject.title}</h3>
              </div>
              <div className="work-detail-role">
                {(selectedProject.period || selectedProject.association) && (
                  <div className="work-detail-role-head">
                    <h4>{selectedProject.association || "Selected Project"}</h4>
                    {selectedProject.period && (
                      <time>{selectedProject.period}</time>
                    )}
                  </div>
                )}
                <p>{selectedProject.description}</p>
                <div className="project-meta">
                  {selectedProject.tech.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
                {selectedProject.link ? (
                  <a
                    href={selectedProject.link}
                    target="_blank"
                    rel="noreferrer"
                    className="project-detail-link"
                    aria-label={`${selectedProject.title} Repository`}
                  >
                    View Repository
                  </a>
                ) : null}
                {selectedProject.paper ? (
                  <a
                    href={selectedProject.paper}
                    target="_blank"
                    rel="noreferrer"
                    className="project-detail-link"
                    aria-label={`${selectedProject.title} Research Paper`}
                  >
                    IEEE Research Paper
                  </a>
                ) : null}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
