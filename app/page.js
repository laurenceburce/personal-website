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
    const handleLinkClick = (event) => {
      const link = event.target?.closest?.("a[href]");
      if (!link) return;

      const href = link.getAttribute("href") || "";
      const label = link.getAttribute("aria-label") || link.textContent?.trim() || href;
      const destination = href.startsWith("http") ? href : link.href || href;

      trackAnalyticsEvent("link_click", `${label.slice(0, 80)} | ${destination.slice(0, 110)}`);
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
