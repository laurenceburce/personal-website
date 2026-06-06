"use client";

import { useEffect } from "react";

// The magnifier loads this page in an iframe with ?magnifier=1.
// In that context, the full page must be visible at any scroll position,
// so scroll-triggered reveals must be skipped entirely.
const isMagnifierFrame = () => {
  try {
    return (
      window.self !== window.top &&
      new URLSearchParams(window.location.search).get("magnifier") === "1"
    );
  } catch {
    return false;
  }
};

export default function useRevealAnimations() {
  useEffect(() => {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const reveals = Array.from(document.querySelectorAll(".reveal"));

    if (reveals.length === 0) return;

    // Reveal everything immediately: reduced-motion users and magnifier iframes.
    if (prefersReducedMotion || isMagnifierFrame()) {
      reveals.forEach((el) => el.classList.add("visible"));
      return;
    }

    // Apply stagger delays to direct .reveal children of .reveal-stagger containers.
    // Each child gets --reveal-delay offset by 70ms, capped at 350ms for deep lists.
    document.querySelectorAll(".reveal-stagger").forEach((container) => {
      const children = Array.from(container.querySelectorAll(":scope > .reveal"));
      children.forEach((child, i) => {
        child.style.setProperty(
          "--reveal-delay",
          `${Math.min(i * 0.07, 0.35).toFixed(2)}s`
        );
      });
    });

    // Items already visible on load shouldn't have a delay — they'd flash invisible.
    const viewportH = window.innerHeight;
    const initiallyVisible = new Set();
    reveals.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.top < viewportH * 0.98 && rect.bottom > 0) {
        initiallyVisible.add(el);
        // Remove stagger delay for elements already in view at load
        el.style.setProperty("--reveal-delay", "0s");
        el.classList.add("visible");
      }
    });

    const pending = reveals.filter((el) => !initiallyVisible.has(el));
    if (pending.length === 0) return;

    // Use IntersectionObserver for clean one-shot reveals.
    // rootMargin pulls the trigger line up slightly so elements reveal
    // just as their top edge enters the lower third of the viewport.
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            observer.unobserve(entry.target);
          }
        });
      },
      {
        threshold: 0.07,
        rootMargin: "0px 0px -5% 0px",
      }
    );

    pending.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, []);
}
