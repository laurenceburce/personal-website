"use client";

import { IcoClose } from "./icons";
import useDraggable from "./useDraggable";

export default function ToolWindow({
  title,
  icon,
  onClose,
  children,
  initX,
  initY,
  width = 290,
  headerActions = null,
  minimized = false
}) {
  const [pos, , startDrag] = useDraggable(initX, initY);
  const renderedChildren =
    typeof children === "function"
      ? children({ windowPos: pos, windowWidth: width })
      : children;

  return (
    <div className={`ft-window${minimized ? " minimized" : ""}`} style={{ left: pos.x, top: pos.y, width }}>
      <div
        className="ft-window-header"
        onPointerDown={(event) => {
          if (event.target.closest?.("button")) return;
          startDrag(event);
        }}
      >
        <span className="ft-window-header-left">
          <span className="ft-window-icon">{icon}</span>
          <span className="ft-window-title">{title}</span>
        </span>
        <span className="ft-window-actions">
          {headerActions}
          <button className="ft-window-close" onClick={onClose} aria-label="Close" type="button">
            <IcoClose />
          </button>
        </span>
      </div>
      <div className="ft-window-body" hidden={minimized}>{renderedChildren}</div>
    </div>
  );
}
