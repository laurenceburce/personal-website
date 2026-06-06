"use client";

import { useEffect, useRef, useState } from "react";

const MAGNIFIER_PROJECT_SELECTION_KEY = "portfolio:magnifier:selected-project";
const PROJECT_SELECTION_MESSAGE = "portfolio:project-selection";
const PROJECT_SELECTION_CHANGED_EVENT = "portfolio:project-selection-changed";

const isMagnifierFrame = () => {
  if (typeof window === "undefined") return false;

  try {
    return window.self !== window.top && new URLSearchParams(window.location.search).get("magnifier") === "1";
  } catch {
    return false;
  }
};

const parseSelectedProject = (value, projectCount) => {
  if (value === null || value === undefined || value === "") return null;

  const next = Number(value);
  return Number.isInteger(next) && next >= 0 && next < projectCount ? next : null;
};

const getInitialSelectedProject = (projectCount) => {
  if (!isMagnifierFrame()) return null;

  try {
    return parseSelectedProject(window.localStorage.getItem(MAGNIFIER_PROJECT_SELECTION_KEY), projectCount);
  } catch {
    return null;
  }
};

export default function ProjectsSection({ projects }) {
  const [selected, setSelected] = useState(() => getInitialSelectedProject(projects.length));
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(false);
  const rowRef = useRef(null);

  const updateFades = () => {
    const el = rowRef.current;
    if (!el) return;
    setShowLeftFade(el.scrollLeft > 4);
    setShowRightFade(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };

  useEffect(() => {
    updateFades();
    const el = rowRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateFades);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (isMagnifierFrame()) return;

    try {
      if (selected === null) {
        window.localStorage.removeItem(MAGNIFIER_PROJECT_SELECTION_KEY);
      } else {
        window.localStorage.setItem(MAGNIFIER_PROJECT_SELECTION_KEY, String(selected));
      }

      window.dispatchEvent(new CustomEvent(PROJECT_SELECTION_CHANGED_EVENT, {
        detail: { selected }
      }));
    } catch {}
  }, [selected]);

  useEffect(() => {
    if (!isMagnifierFrame()) return undefined;

    const applySelection = (value) => {
      setSelected(parseSelectedProject(value, projects.length));
    };

    const onStorage = (event) => {
      if (event.key === MAGNIFIER_PROJECT_SELECTION_KEY) {
        applySelection(event.newValue);
      }
    };

    const onMessage = (event) => {
      if (event.data?.type === PROJECT_SELECTION_MESSAGE) {
        applySelection(event.data.selected);
      }
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
          {showLeftFade && <div className="work-fade work-fade--left" aria-hidden="true" />}
          {showRightFade && <div className="work-fade work-fade--right" aria-hidden="true" />}
          <div className="work-cards-row project-cards-row" ref={rowRef} onScroll={updateFades}>
            {projects.map((project, i) => (
              <article
                className={`work-card project-card${selected === i ? " work-card--active project-card--active" : ""}`}
                key={project.title}
                role="button"
                tabIndex={0}
                onClick={() => handleSelect(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleSelect(i);
                  }
                }}
                aria-expanded={selected === i}
              >
                <span className="project-card-index">{String(i + 1).padStart(2, "0")}</span>
                <div className="work-card-info project-card-info">
                  <span className="project-card-kicker">
                    {project.association || "Featured Project"}
                  </span>
                  <span className="work-card-company project-card-title">{project.title}</span>
                  {(project.period || project.association) && (
                    <span className="work-card-meta project-card-meta-line">
                      {[project.period, project.association].filter(Boolean).map((item, i, arr) => (
                        <span key={i}>
                          {item}
                          {i < arr.length - 1 && (
                            <svg width="3" height="3" viewBox="0 0 3 3" aria-hidden="true" style={{ display: "inline-block", verticalAlign: "middle", margin: "0 4px", flexShrink: 0 }}><circle cx="1.5" cy="1.5" r="1.5" fill="currentColor"/></svg>
                          )}
                        </span>
                      ))}
                    </span>
                  )}
                  <div className="project-card-tech" aria-label={`${project.title} technologies`}>
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
                      onClick={(e) => e.stopPropagation()}
                    >
                      Repository
                    </a>
                  ) : null}
                  <span className="project-card-detail">View details</span>
                </div>
                <svg
                  className="work-card-chevron"
                  width="14" height="14" viewBox="0 0 14 14"
                  fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points={selected === i ? "2 9 7 4 12 9" : "2 5 7 10 12 5"} />
                </svg>
              </article>
            ))}
          </div>
        </div>

        {selectedProject && (
          <div className="work-detail project-detail" key={selectedProject.title}>
            <div className="work-detail-header">
              <h3>{selectedProject.title}</h3>
            </div>
            <div className="work-detail-role">
              {(selectedProject.period || selectedProject.association) && (
                <div className="work-detail-role-head">
                  <h4>{selectedProject.association || "Selected Project"}</h4>
                  {selectedProject.period && <time>{selectedProject.period}</time>}
                </div>
              )}
              <p>{selectedProject.description}</p>
              <div className="project-meta">
                {selectedProject.tech.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
              {selectedProject.link ? (
                <a href={selectedProject.link} target="_blank" rel="noreferrer" className="project-detail-link">
                  View Repository
                </a>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
