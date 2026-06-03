"use client";

import { useEffect, useState } from "react";

export default function useBoundedSidebarOffset(contentLayoutRef, sidebarRef) {
  const [sidebarOffset, setSidebarOffset] = useState(0);

  useEffect(() => {
    let frameId = 0;

    const updateSidebarOffset = () => {
      const container = contentLayoutRef.current;
      const sidebar = sidebarRef.current;

      if (!container || !sidebar || window.innerWidth <= 1024) {
        setSidebarOffset(0);
        return;
      }

      const computedTop = Number.parseFloat(window.getComputedStyle(sidebar).top);
      const topOffset = Number.isFinite(computedTop) ? computedTop : 16;
      const sidebarHeight = sidebar.offsetHeight;
      const rect = container.getBoundingClientRect();
      const scrollY = window.scrollY;
      const containerTop = rect.top + scrollY;
      const containerBottom = rect.bottom + scrollY;
      const start = containerTop;
      const end = containerBottom - sidebarHeight - topOffset * 2;

      let nextOffset = 0;

      if (scrollY < start) {
        nextOffset = start - scrollY;
      } else if (scrollY > end) {
        nextOffset = end - scrollY;
      }

      setSidebarOffset((current) => {
        if (Math.abs(current - nextOffset) < 0.25) {
          return current;
        }

        return nextOffset;
      });
    };

    const requestUpdate = () => {
      if (frameId) return;

      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        updateSidebarOffset();
      });
    };

    requestUpdate();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }

      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
    };
  }, [contentLayoutRef, sidebarRef]);

  return sidebarOffset;
}
