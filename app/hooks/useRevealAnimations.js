"use client";

import { useEffect } from "react";

export default function useRevealAnimations() {
  useEffect(() => {
    const reveals = Array.from(document.querySelectorAll(".reveal"));

    if (reveals.length === 0) {
      return;
    }

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    reveals.forEach((el) => {
      if (prefersReducedMotion) {
        el.style.setProperty("--reveal-progress", "1");
        el.classList.add("visible");
      }
    });

    if (prefersReducedMotion) {
      return;
    }

    let frameId = 0;

    const updateScrollAnimations = () => {
      const viewportHeight = window.innerHeight || 1;

      reveals.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const start = viewportHeight * 0.88;
        const end = viewportHeight * 0.28;
        const rawProgress = (start - rect.top) / (start - end);
        const progress = Math.max(0, Math.min(1, rawProgress));
        const revealProgress = 1 - Math.pow(1 - progress, 2);

        el.style.setProperty("--reveal-progress", revealProgress.toFixed(3));

        if (revealProgress >= 0.5) {
          el.classList.add("visible");
        } else {
          el.classList.remove("visible");
        }
      });

      const atPageBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 6;

      if (atPageBottom) {
        reveals.forEach((el) => {
          el.style.setProperty("--reveal-progress", "1");
          el.classList.add("visible");
        });
      }
    };

    const requestScrollUpdate = () => {
      if (frameId) return;

      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        updateScrollAnimations();
      });
    };

    updateScrollAnimations();
    window.addEventListener("scroll", requestScrollUpdate, { passive: true });
    window.addEventListener("resize", requestScrollUpdate);

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }

      window.removeEventListener("scroll", requestScrollUpdate);
      window.removeEventListener("resize", requestScrollUpdate);
    };
  }, []);
}
