"use client";

import { useCallback, useRef, useState } from "react";

export default function useDraggable(initX, initY) {
  const [pos, setPos] = useState({ x: initX, y: initY });
  const posRef = useRef({ x: initX, y: initY });
  posRef.current = pos;

  const startDrag = useCallback((event, onClick) => {
    if (event.button !== 0) return;

    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    const originX = posRef.current.x;
    const originY = posRef.current.y;
    let moved = false;

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        moved = true;
      }

      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 56, originX + dx)),
        y: Math.max(0, Math.min(window.innerHeight - 56, originY + dy))
      });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);

      if (!moved && onClick) {
        onClick();
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  return [pos, setPos, startDrag];
}
