"use client";

import { useEffect, useRef, useState } from "react";

// Lerp factor: how quickly the displayed progress catches up to the real scroll.
// 0.12 gives a smooth, slightly springy follow that still feels responsive.
const LERP = 0.12;

export default function useScrollProgress() {
  const [scrollProgress, setScrollProgress] = useState(0);
  const displayedRef = useRef(0);
  const targetRef    = useRef(0);
  const frameRef     = useRef(0);
  const runningRef   = useRef(false);

  useEffect(() => {
    const getTarget = () => {
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      return maxScroll > 0 ? Math.min(1, Math.max(0, window.scrollY / maxScroll)) : 0;
    };

    const animate = () => {
      const target   = targetRef.current;
      const current  = displayedRef.current;
      const next     = current + (target - current) * LERP;
      const snapped  = Math.abs(next - target) < 0.0005 ? target : next;

      if (Math.abs(snapped - current) > 0.0001) {
        displayedRef.current = snapped;
        setScrollProgress(snapped);
        frameRef.current = requestAnimationFrame(animate);
      } else {
        runningRef.current = false;
      }
    };

    const handleScroll = () => {
      targetRef.current = getTarget();

      if (!runningRef.current) {
        runningRef.current = true;
        frameRef.current   = requestAnimationFrame(animate);
      }
    };

    // Seed initial value without animation (no lerp on first paint)
    const initial = getTarget();
    displayedRef.current = initial;
    targetRef.current    = initial;
    setScrollProgress(initial);

    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll,  { passive: true });

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
    };
  }, []);

  return scrollProgress;
}
