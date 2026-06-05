"use client";
import { useEffect, useRef, useState } from "react";
import formatDurationFromPeriod from "../../utils/formatDurationFromPeriod";

export default function WorkSection({ timeline }) {
  const [selected, setSelected] = useState(null);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(false);

  const rowRef = useRef(null);
  const wrapRef = useRef(null);

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

  const handleSelect = (i) => setSelected(selected === i ? null : i);

  const selectedEntry = selected !== null ? timeline[selected] : null;

  return (
    <section id="work" className="section reveal">
      <div className="section-head">
        <h2>Work Experience</h2>
      </div>
      <div className="work-list">
        <div className="work-carousel-wrap" ref={wrapRef}>
          {showLeftFade && <div className="work-fade work-fade--left" aria-hidden="true" />}
          {showRightFade && <div className="work-fade work-fade--right" aria-hidden="true" />}
          <div className="work-cards-row" ref={rowRef} onScroll={updateFades}>
            {timeline.map((entry, i) => (
              <div
                key={entry.company}
                role="button"
                tabIndex={0}
                className={`work-card${selected === i ? " work-card--active" : ""}`}
                onClick={() => handleSelect(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleSelect(i);
                  }
                }}
                aria-expanded={selected === i}
              >
                <span className={`work-card-logo brand-mark brand-mark-${entry.logoClass}`}>
                  <img src={entry.logoUrl} alt={entry.company} loading="lazy" />
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
                  onClick={(e) => e.stopPropagation()}
                >
                  Website ↗
                </a>
                <svg
                  className="work-card-chevron"
                  width="14" height="14" viewBox="0 0 14 14"
                  fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points={selected === i ? "2 9 7 4 12 9" : "2 5 7 10 12 5"} />
                </svg>
              </div>
            ))}
          </div>
        </div>

        {selectedEntry && (
          <div className="work-detail" key={selectedEntry.company}>
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
          </div>
        )}
      </div>
    </section>
  );
}
