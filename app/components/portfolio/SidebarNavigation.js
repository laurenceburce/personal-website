"use client";

import { forwardRef } from "react";
import { IconGitHub, IconLinkedIn, IconMail, SidebarIcon } from "./icons";
import SidebarContactForm from "./SidebarContactForm";
import ThemeSwitch from "./ThemeSwitch";

const SidebarNavigation = forwardRef(function SidebarNavigation({
  navItems,
  activeSectionId,
  scrollProgress,
  sidebarOffset,
  theme,
  onThemeChange,
  contact
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
      <SidebarContactForm
        form={contact.form}
        errors={contact.errors}
        status={contact.status}
        isSubmitting={contact.isSubmitting}
        onChange={contact.handleChange}
        onSubmit={contact.handleSubmit}
      />
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
