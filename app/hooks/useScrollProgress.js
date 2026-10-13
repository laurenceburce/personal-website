"use client";

import { useMotionValue } from "framer-motion";
import { useEffect } from "react";

export default function useScrollProgress() {
  // Motion values update the indicator without rerendering the portfolio.
  const scrollProgress = useMotionValue(0);

  useEffect(() => {
    let frameId = 0;

    const updateProgress = () => {
      frameId = 0;
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      scrollProgress.set(
        maxScroll > 0 ? Math.min(1, Math.max(0, window.scrollY / maxScroll)) : 0
      );
    };

    const requestUpdate = () => {
      if (!frameId) {
        frameId = window.requestAnimationFrame(updateProgress);
      }
    };

    updateProgress();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);

    // Expanded details and loaded assets can change progress even while idle.
    const resizeObserver = new ResizeObserver(requestUpdate);
    resizeObserver.observe(document.documentElement);
    resizeObserver.observe(document.body);

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
    };
  }, [scrollProgress]);

  return scrollProgress;
}
