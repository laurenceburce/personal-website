export default function HeroSection() {
  return (
    <section className="hero section reveal">
      <div className="hero-card">
        <a href="#home" className="hero-logo-mark" aria-label="Laurence Alec Burce home">
          <img src="/logos/lab-favicon.svg" alt="" aria-hidden="true" />
        </a>
        <div className="hero-copy">
          <p className="welcome-line">Hello, I&rsquo;m Laurence.</p>
          <div className="hero-badge">
            <span className="hero-badge-dot" aria-hidden="true" />
            Available for new opportunities
          </div>
          <p className="lead">
            Software engineer with 3+ years of experience building reliable{" "}
            enterprise applications, backend services, and AI-enabled tools
            for teams that need practical, maintainable solutions.
          </p>
          <p className="lead" style={{ marginTop: "1rem" }}>
            Based in <strong>Santee, California</strong>; open to{" "}
            <strong>San Diego</strong> or <strong>remote roles</strong>.
          </p>
        </div>
      </div>
    </section>
  );
}
