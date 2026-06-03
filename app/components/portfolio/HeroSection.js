import { IconArrowRight, IconDownload } from "./icons";

export default function HeroSection() {
  return (
    <section className="hero section reveal">
      <div className="hero-badge">
        <span className="hero-badge-dot" aria-hidden="true" />
        Available for new opportunities
      </div>
      <p className="welcome-line">Hello, I'm Laurence.</p>
      <p className="eyebrow">Software Engineer · AI & Automation Engineer</p>
      <h1>
        I'm a software engineer building automation-first systems for modern
        operations teams.
      </h1>
      <p className="lead">
        2+ years of enterprise development experience at Oracle and hands-on
        AI automation delivery for large-scale real estate and property
        management organizations.
      </p>
      <div className="hero-actions">
        <a className="btn btn-primary" href="#projects">
          <IconArrowRight />
          View Projects
        </a>
        <a
          className="btn btn-secondary"
          href="/Laurence-Alec-Burce-Software-Developer-Resume.pdf"
          download
        >
          <IconDownload />
          Download Resume
        </a>
        <a
          className="btn btn-secondary"
          href="/Laurence-Alec-Burce-Cover-Letter.pdf"
          download
        >
          <IconDownload />
          Download Cover Letter
        </a>
      </div>
    </section>
  );
}
