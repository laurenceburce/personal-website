import DownloadGate from "./DownloadGate";
import { IconGitHub, IconLinkedIn, IconMail, IconPhone, SidebarIcon } from "./icons";
import { downloadLinks } from "./navigationLinks";
import { SidebarAnalyticsPanel } from "./SidebarAnalytics";
import ThemeSwitch from "./ThemeSwitch";

export default function SiteHeader({
  navItems,
  menuOpen,
  theme,
  activeSectionId,
  analytics,
  onThemeChange,
  onMenuToggle,
  onMenuClose
}) {
  const navClassName = ["site-nav", menuOpen ? "open" : ""].filter(Boolean).join(" ");

  return (
    <>
      <header className="site-header">
        <a href="#home" className="brand" aria-label="Home">
          Laurence Alec Burce
        </a>
        <ThemeSwitch theme={theme} onChange={onThemeChange} className="mobile-theme-toggle" />
        <button
          className="menu-toggle"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          onClick={onMenuToggle}
          type="button"
        >
          <span />
          <span />
          <span />
        </button>
        <nav className={navClassName} aria-label="Main navigation">
          <div className="mobile-nav-profile" aria-hidden={!menuOpen}>
            <p className="mobile-nav-kicker">Quick Navigation</p>
            <a href="#home" className="mobile-nav-brand" aria-label="Home" onClick={onMenuClose}>
              Laurence Alec Burce
            </a>
            <p className="mobile-nav-role">
              Software Engineer
              <svg width="3" height="3" viewBox="0 0 3 3" aria-hidden="true" style={{ display: "inline-block", verticalAlign: "middle", margin: "0 5px", flexShrink: 0 }}>
                <circle cx="1.5" cy="1.5" r="1.5" fill="currentColor" />
              </svg>
              AI &amp; Automation Engineer
            </p>
            <a href="mailto:laurenceburce@gmail.com" className="mobile-nav-email" aria-label="Email Laurence">
              <IconMail />
              laurenceburce@gmail.com
            </a>
            <a href="tel:+16196350470" className="mobile-nav-email" aria-label="Call Laurence">
              <IconPhone />
              +1 619 635 0470
            </a>
            <div className="mobile-nav-social">
              <a href="https://github.com/laurenceburce" target="_blank" rel="noreferrer" aria-label="GitHub Profile">
                <IconGitHub />
                GitHub
              </a>
              <a href="https://www.linkedin.com/in/laurence-burce" target="_blank" rel="noreferrer" aria-label="LinkedIn Profile">
                <IconLinkedIn />
                LinkedIn
              </a>
            </div>
            <div className="mobile-nav-downloads" aria-label="Downloads">
              <DownloadGate links={downloadLinks} />
            </div>
          </div>

          <div className="mobile-nav-section-title">Sections</div>
          {navItems.map((item) => (
            <a
              key={item.id}
              href={item.href}
              aria-label={item.label}
              className={activeSectionId === item.id ? "active" : undefined}
              aria-current={activeSectionId === item.id ? "location" : undefined}
              onClick={onMenuClose}
            >
              <span className="mobile-nav-link-label">
                <span className="nav-icon">
                  <SidebarIcon type={item.icon} />
                </span>
                <span>{item.label}</span>
              </span>
            </a>
          ))}
          <SidebarAnalyticsPanel analytics={analytics} className="mobile-nav-analytics" />
        </nav>
      </header>
    </>
  );
}
