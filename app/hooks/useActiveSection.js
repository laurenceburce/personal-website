"use client";

import { useEffect, useState } from "react";

export default function useActiveSection(navItems) {
  const [activeSectionId, setActiveSectionId] = useState(navItems[0]?.id ?? "");

  useEffect(() => {
    const sectionIds = navItems.map((item) => item.id);
    const sections = sectionIds
      .map((id) => document.getElementById(id))
      .filter(Boolean);

    if (sections.length === 0) {
      return;
    }

    let frameId = 0;

    const updateActiveSection = () => {
      const marker = window.innerHeight * 0.36;
      const nearPageBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 6;

      let currentId = sections[0].id;

      sections.forEach((section) => {
        if (section.getBoundingClientRect().top <= marker) {
          currentId = section.id;
        }
      });

      if (nearPageBottom) {
        currentId = sections[sections.length - 1].id;
      }

      setActiveSectionId((prev) => (prev === currentId ? prev : currentId));
    };

    const requestUpdate = () => {
      if (frameId) return;

      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        updateActiveSection();
      });
    };

    updateActiveSection();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }

      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
    };
  }, [navItems]);

  return activeSectionId;
}
