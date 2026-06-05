"use client";

import { forwardRef } from "react";
import { IconDownload, IconGitHub, IconLinkedIn, IconMail, IconPhone, SidebarIcon } from "./icons";
import { downloadLinks, trackDownload } from "./navigationLinks";
import { SidebarAnalyticsPanel } from "./SidebarAnalytics";
import ThemeSwitch from "./ThemeSwitch";

const SidebarNavigation = forwardRef(function SidebarNavigation({
  navItems,
  activeSectionId,
  scrollProgress,
  sidebarOffset,
  theme,
  onThemeChange,
  analytics
}, ref) {
  return (
    <aside
      ref={ref}
      className="global-scroll-indicator sidebar-fixed"
      style={{ transform: `translate3d(0, ${sidebarOffset}px, 0)` }}
      aria-label="Section navigation"
    >
      <div className="scroll-profile">
        <p className="scroll-kicker">Quick Navigation</p>
        <a href="#home" className="scroll-brand">
          Laurence Alec Burce
        </a>
        <p className="scroll-role">Software Engineer • AI & Automation Engineer</p>
        <a href="mailto:laurenceburce@gmail.com" className="scroll-email">
          <IconMail />
          laurenceburce@gmail.com
        </a>
        <a href="tel:+16196350470" className="scroll-email">
          <IconPhone />
          +1 619 635 0470
        </a>
        <div className="scroll-social">
          <a href="https://github.com/laurenceburce" target="_blank" rel="noreferrer" className="scroll-social-link">
            <IconGitHub />
            GitHub
          </a>
          <a href="https://www.linkedin.com/in/laurence-burce" target="_blank" rel="noreferrer" className="scroll-social-link">
            <IconLinkedIn />
            LinkedIn
          </a>
        </div>
        <div className="scroll-downloads" aria-label="Downloads">
          {downloadLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              download
              className={`scroll-download-link scroll-download-${link.tone}`}
              aria-label={link.ariaLabel}
              onClick={() => trackDownload(link.label)}
            >
              <IconDownload />
              <span>{link.label}</span>
            </a>
          ))}
        </div>
      </div>
      <nav className="scroll-nav" aria-label="Section navigation">
        {navItems.map((item) => (
          <a
            key={item.id}
            href={item.href}
            className={activeSectionId === item.id ? "active" : undefined}
            aria-current={activeSectionId === item.id ? "location" : undefined}
          >
            <span className="nav-left">
              <span className="nav-icon">
                <SidebarIcon type={item.icon} />
              </span>
              <span>{item.label}</span>
            </span>
            <small>{item.number}</small>
          </a>
        ))}
      </nav>
      <SidebarAnalyticsPanel analytics={analytics} />
      <a href="#home" className="sidebar-logo-mark" aria-label="Laurence Alec Burce home">
        <img src="/logos/lab-favicon.svg" alt="" aria-hidden="true" />
      </a>
      <ThemeSwitch theme={theme} onChange={onThemeChange} className="sidebar-theme-toggle" />
      <div className="indicator-rail" aria-hidden="true">
        <div className="indicator-node">
          <span />
        </div>
        <div className="indicator-track">
          <div
            className="indicator-progress"
            style={{ height: `${Math.max(3, scrollProgress * 100)}%` }}
          />
          <div
            className="indicator-thumb"
            style={{ top: `${scrollProgress * 100}%` }}
          />
        </div>
      </div>
    </aside>
  );
});

export default SidebarNavigation;
