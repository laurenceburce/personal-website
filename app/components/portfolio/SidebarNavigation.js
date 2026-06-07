"use client";

import { forwardRef } from "react";
import DownloadGate from "./DownloadGate";
import { IconGitHub, IconLinkedIn, IconMail, IconPhone, SidebarIcon } from "./icons";
import { downloadLinks } from "./navigationLinks";
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
      <ThemeSwitch theme={theme} onChange={onThemeChange} className="sidebar-theme-toggle" />
      <div className="scroll-profile">
        <p className="scroll-kicker">Quick Navigation</p>
        <a href="#home" className="scroll-brand" aria-label="Home">
          Laurence Alec Burce
        </a>
        <p className="scroll-role">
          Software Engineer
          <svg
            width="3" height="3" viewBox="0 0 3 3"
            aria-hidden="true"
            style={{ display: "inline-block", verticalAlign: "middle", margin: "0 5px", flexShrink: 0 }}
          >
            <circle cx="1.5" cy="1.5" r="1.5" fill="currentColor" />
          </svg>
          AI &amp; Automation Engineer
        </p>
        <a href="mailto:laurenceburce@gmail.com" className="scroll-email" aria-label="Email Laurence">
          <IconMail />
          laurenceburce@gmail.com
        </a>
        <a href="tel:+16196350470" className="scroll-email" aria-label="Call Laurence">
          <IconPhone />
          +1 619 635 0470
        </a>
        <div className="scroll-social">
          <a
            href="https://github.com/laurenceburce"
            target="_blank"
            rel="noreferrer"
            className="scroll-social-link"
            aria-label="GitHub Profile"
          >
            <IconGitHub />
            GitHub
          </a>
          <a
            href="https://www.linkedin.com/in/laurence-burce"
            target="_blank"
            rel="noreferrer"
            className="scroll-social-link"
            aria-label="LinkedIn Profile"
          >
            <IconLinkedIn />
            LinkedIn
          </a>
        </div>
        <div className="scroll-downloads" aria-label="Downloads">
          <DownloadGate links={downloadLinks} />
        </div>
      </div>
      <nav className="scroll-nav" aria-label="Section navigation">
        {navItems.map((item) => (
          <a
            key={item.id}
            href={item.href}
            aria-label={item.label}
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
