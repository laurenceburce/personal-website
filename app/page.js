"use client";

import { useEffect, useRef, useState } from "react";
import FloatingToolbar from "./components/FloatingToolbar";
import AboutSection from "./components/portfolio/AboutSection";
import BackgroundEffects from "./components/portfolio/BackgroundEffects";
import EducationSection from "./components/portfolio/EducationSection";
import HeroSection from "./components/portfolio/HeroSection";
import ProjectsSection from "./components/portfolio/ProjectsSection";
import SidebarNavigation from "./components/portfolio/SidebarNavigation";
import SiteHeader from "./components/portfolio/SiteHeader";
import SkillsSection from "./components/portfolio/SkillsSection";
import WorkSection from "./components/portfolio/WorkSection";
import { navItems, projects, skillGroups, timeline } from "./data/portfolio";
import useActiveSection from "./hooks/useActiveSection";
import useBoundedSidebarOffset from "./hooks/useBoundedSidebarOffset";
import usePortfolioAnalytics from "./hooks/usePortfolioAnalytics";
import useRevealAnimations from "./hooks/useRevealAnimations";
import useScrollProgress from "./hooks/useScrollProgress";
import useThemePreference from "./hooks/useThemePreference";
import { trackAnalyticsEvent } from "./utils/analyticsClient";

export default function Home() {
  const [menuOpen, setMenuOpen] = useState(false);
  const contentLayoutRef = useRef(null);
  const sidebarRef = useRef(null);
  const { theme, setTheme } = useThemePreference();
  const activeSectionId = useActiveSection(navItems);
  const scrollProgress = useScrollProgress();
  const sidebarOffset = useBoundedSidebarOffset(contentLayoutRef, sidebarRef);
  const analytics = usePortfolioAnalytics();

  useRevealAnimations();

  useEffect(() => {
    if (!menuOpen) return;

    const closeOnScroll = () => setMenuOpen(false);

    window.addEventListener("scroll", closeOnScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", closeOnScroll);
    };
  }, [menuOpen]);

  useEffect(() => {
    const sectionIdMap = {
      about: "About",
      work: "Work",
      education: "Education",
      skills: "Skills"
    };

    const getSection = (link) => {
      if (link.closest("aside.sidebar-fixed, aside[aria-label='Section navigation']")) return "Sidebar";
      if (link.closest("header")) return "Header";
      for (const [id, name] of Object.entries(sectionIdMap)) {
        if (link.closest(`#${id}`)) return name;
      }
      return "Link";
    };

    const handleLinkClick = (event) => {
      const link = event.target?.closest?.("a[href]");
      if (!link) return;
      if (link.dataset.analyticsSkip) return;

      const ariaLabel = link.getAttribute("aria-label") || "";
      const text = link.textContent?.trim() || "";
      const raw = (ariaLabel || text).replace(/\s+/g, " ").trim();
      const href = link.getAttribute("href") || "";
      const destination = href.startsWith("http") ? href : (link.href || href);

      // Project links: aria-label is "[Project Title] Repository" or "[Project Title] Research Paper".
      // Use the project title as section and a short link-type label.
      if (link.closest("#projects") && raw) {
        if (/\s+Repository$/i.test(raw)) {
          const title = raw.replace(/\s+Repository$/i, "").trim();
          trackAnalyticsEvent(`${title}: GitHub`.slice(0, 50), destination.slice(0, 200));
          return;
        }
        if (/\s+Research Paper$/i.test(raw)) {
          const title = raw.replace(/\s+Research Paper$/i, "").trim();
          trackAnalyticsEvent(`${title}: IEEE Paper`.slice(0, 50), destination.slice(0, 200));
          return;
        }
      }

      // All other links: derive section from DOM position, label from aria/text.
      let label = raw;
      if (/^(GitHub|LinkedIn)\s+Profile$/i.test(raw)) label = raw.replace(/\s+Profile$/i, "");
      else if (/^Email\s+\w+/i.test(raw)) label = "Email";
      else if (/^Call\s+\w+/i.test(raw)) label = "Phone";
      else if (/^Open\s+menu$/i.test(raw)) return;
      if (!label) return;

      const section = getSection(link);
      if (section === "Sidebar") return;
      trackAnalyticsEvent(`${section}: ${label}`.slice(0, 50), destination.slice(0, 200));
    };

    document.addEventListener("click", handleLinkClick, true);
    return () => document.removeEventListener("click", handleLinkClick, true);
  }, []);

  const handleThemeSwitchChange = (event) => {
    setTheme(event.target.checked ? "dark" : "light");
  };

  return (
    <>
      <FloatingToolbar />
      <BackgroundEffects />

      <SiteHeader
        navItems={navItems}
        menuOpen={menuOpen}
        theme={theme}
        activeSectionId={activeSectionId}
        analytics={analytics}
        onThemeChange={handleThemeSwitchChange}
        onMenuToggle={() => setMenuOpen((open) => !open)}
        onMenuClose={() => setMenuOpen(false)}
      />

      <main id="home" className="main-shell">
        <div className="content-layout" ref={contentLayoutRef}>
          <SidebarNavigation
            ref={sidebarRef}
            navItems={navItems}
            activeSectionId={activeSectionId}
            scrollProgress={scrollProgress}
            sidebarOffset={sidebarOffset}
            theme={theme}
            onThemeChange={handleThemeSwitchChange}
            analytics={analytics}
          />

          <div className="main-sections">
            <HeroSection />
            <AboutSection />
            <WorkSection timeline={timeline} />
            <EducationSection />
            <SkillsSection skillGroups={skillGroups} />
            <ProjectsSection projects={projects} />
          </div>
        </div>
      </main>
    </>
  );
}
