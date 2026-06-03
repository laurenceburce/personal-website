export default function ProjectsSection({ projects }) {
  return (
    <section id="projects" className="section reveal">
      <div className="section-head">
        <h2>Projects</h2>
        <p>
          Production-focused systems spanning automation, enterprise APIs,
          and internal business tooling.
        </p>
      </div>
      <div className="project-grid">
        {projects.map((project) => (
          <article className="project-card" key={project.title}>
            <h3>{project.title}</h3>
            <p>{project.description}</p>
            {project.link ? (
              <p>
                <a href={project.link} target="_blank" rel="noreferrer">
                  View Repository
                </a>
              </p>
            ) : null}
            <div className="project-meta">
              {project.tech.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
