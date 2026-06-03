import formatDurationFromPeriod from "../../utils/formatDurationFromPeriod";

export default function TimelineEntry({ entry }) {
  return (
    <article className="timeline-item">
      <div className="timeline-grid">
        <div className="timeline-logo-column">
          <span className={`brand-mark ${entry.logoClass ? `brand-mark-${entry.logoClass}` : ""}`}>
            <img src={entry.logoUrl} alt="" aria-hidden="true" loading="lazy" />
          </span>
          <div className="timeline-logo-meta">
            <span>{entry.location}</span>
            <a href={entry.website} target="_blank" rel="noreferrer">
              Website
            </a>
          </div>
        </div>
        <div className="timeline-body">
          <div className="timeline-head">
            <h3>{entry.company}</h3>
            <time>{formatDurationFromPeriod(entry.period)}</time>
          </div>
          <div className="timeline-role-list">
            {entry.roles.map((role) => (
              <article className="timeline-role-item" key={role.title}>
                <div className="timeline-role-head">
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
              </article>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}
