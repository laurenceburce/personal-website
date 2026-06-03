import formatDurationFromPeriod from "../../utils/formatDurationFromPeriod";

export default function EducationSection() {
  return (
    <section id="education" className="section reveal">
      <div className="section-head">
        <h2>Education</h2>
      </div>
      <article className="timeline-item">
        <div className="timeline-grid">
          <div className="timeline-logo-column">
            <span className="brand-mark brand-mark-mapua">
              <img
                src="/logos/mapua-university-logo.png"
                alt=""
                aria-hidden="true"
                loading="lazy"
              />
            </span>
            <div className="timeline-logo-meta">
              <span>Manila, Philippines</span>
              <a href="https://www.mapua.edu.ph" target="_blank" rel="noreferrer">
                Website
              </a>
            </div>
          </div>
          <div className="timeline-body">
            <div className="timeline-head">
              <h3>Mapua University</h3>
              <time>{formatDurationFromPeriod("Aug 2017 - Feb 2022")}</time>
            </div>
            <div className="timeline-role-list">
              <article className="timeline-role-item">
                <div className="timeline-role-head">
                  <h4>B.S. in Computer Engineering</h4>
                  <time>Aug 2017 - Feb 2022</time>
                </div>
                <p>
                  Specialization in HP Unix Administration
                  <br />
                  Academic Scholar
                  <br />
                  GWA: 2.01 / 1.00
                  <br />
                  GPA equivalent ≈ 3.3
                </p>
              </article>
            </div>
          </div>
        </div>
      </article>
    </section>
  );
}
