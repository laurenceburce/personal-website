"use client";

import { useEffect, useRef, useState } from "react";

export const DEFAULT_PLANNER_ZOOM = 75;
export const MIN_PLANNER_ZOOM = 25;
export const MAX_PLANNER_ZOOM = 200;
const STORAGE_KEY = "finance:planner:fullscreen-zoom:v1";
const clamp = (value) => Math.max(MIN_PLANNER_ZOOM, Math.min(MAX_PLANNER_ZOOM, Math.round(value)));
const tableWidth = (node) => node.querySelector?.("table")?.getBoundingClientRect().width || 0;
const center = (node) => ({ x: (node.clientWidth || 0) / 2, y: (node.clientHeight || 0) / 2 });

function capture(node, point, scale) {
  const target = (node.getBoundingClientRect?.().top || 0) + point.y;
  let row = null;
  const rows = node.querySelectorAll?.("tbody tr") || [];
  let low = 0, high = rows.length - 1;
  while (low <= high) {
    const index = Math.floor((low + high) / 2);
    const element = rows[index];
    const rect = element.getBoundingClientRect();
    if (rect.height > 0 && rect.top <= target && rect.bottom > target) {
      row = { element, fraction: (target - rect.top) / rect.height };
      break;
    }
    if (rect.top > target) high = index - 1;
    else low = index + 1;
  }
  return { node, point, scale, x: node.scrollLeft + point.x, y: node.scrollTop + point.y, width: tableWidth(node), row };
}

function restore(anchor, scale) {
  const { node, point } = anchor;
  const width = tableWidth(node);
  const horizontalRatio = anchor.width && width ? width / anchor.width : scale / anchor.scale;
  const left = Math.max(0, anchor.x * horizontalRatio - point.x);
  let top = anchor.y * scale / anchor.scale - point.y;
  if (anchor.row && anchor.row.element.isConnected !== false) {
    const rect = anchor.row.element.getBoundingClientRect();
    top = node.scrollTop + rect.top - (node.getBoundingClientRect?.().top || 0) + rect.height * anchor.row.fraction - point.y;
  }
  node.scrollLeft = left;
  node.scrollTop = Math.max(0, top);
}

/** Zoom only the ledger; keep fullscreen navigation and editing dialogs readable. */
export default function usePlannerZoom({ fullscreen, scrollerRef }) {
  const [zoom, setPreference] = useState(DEFAULT_PLANNER_ZOOM);
  const preference = useRef(zoom);
  const view = useRef(null);
  const pending = useRef(null);
  const attachment = useRef(null);
  preference.current = zoom;

  const update = (requested, point, gestureAnchor) => {
    if (requested == null || requested === "" || !Number.isFinite(Number(requested))) return;
    const next = clamp(Number(requested));
    const node = scrollerRef.current;
    if (fullscreen && node) {
      const scale = view.current?.node === node ? view.current.scale : preference.current / 100;
      const focalPoint = point || center(node);
      pending.current = gestureAnchor ? { ...gestureAnchor, point: focalPoint } : capture(node, focalPoint, scale);
      if (next === preference.current && scale === next / 100) {
        restore(pending.current, scale);
        pending.current = null;
      }
    }
    preference.current = next;
    setPreference(next);
    try { window.localStorage.setItem(STORAGE_KEY, String(next)); }
    catch { /* Zoom remains usable when browser storage is unavailable. */ }
  };
  const setZoom = (requested) => update(requested);
  const resetZoom = () => update(DEFAULT_PLANNER_ZOOM);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      const value = Number(saved);
      if (saved && Number.isFinite(value) && value >= MIN_PLANNER_ZOOM && value <= MAX_PLANNER_ZOOM) {
        preference.current = Math.round(value);
        setPreference(Math.round(value));
      }
    } catch { /* The smaller default works without stored preferences. */ }
  }, []);

  // Re-check the actual node after every commit, including empty-to-loaded rows.
  useEffect(() => {
    const node = scrollerRef.current;
    const scale = fullscreen ? zoom / 100 : 1;
    const previous = view.current;
    if (node && previous?.node === node && previous.scale !== scale) {
      const anchor = pending.current?.node === node ? pending.current : {
        ...previous.anchor, point: center(node),
      };
      restore(anchor, scale);
    }
    pending.current = null;
    const remember = () => { view.current = node ? { node, scale, anchor: capture(node, center(node), scale) } : null; };
    remember();
    if (attachment.current?.node === node && attachment.current.fullscreen === fullscreen) return;
    attachment.current?.cleanup();
    attachment.current = null;
    if (!node) return;

    // The callback reads the committed scale, rather than a stale render's zoom.
    const trackScroll = () => {
      const currentScale = view.current?.scale || 1;
      view.current = { node, scale: currentScale, anchor: capture(node, center(node), currentScale) };
    };
    let gesture = null;
    const touchPoint = (touches) => {
      const rect = node.getBoundingClientRect();
      return { x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left,
        y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top };
    };
    const distance = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const begin = (event) => {
      gesture = null;
      if (event.touches.length < 2) return;
      const length = distance(event.touches);
      if (!length) return;
      gesture = { distance: length, zoom: preference.current,
        anchor: capture(node, touchPoint(event.touches), view.current?.scale || preference.current / 100) };
      if (event.cancelable) event.preventDefault();
    };
    const move = (event) => {
      if (event.touches.length < 2) { gesture = null; return; }
      if (!gesture) begin(event);
      if (!gesture) return;
      if (event.cancelable) event.preventDefault();
      update(gesture.zoom * distance(event.touches) / gesture.distance, touchPoint(event.touches), gesture.anchor);
    };
    const end = (event) => { gesture = null; if (event.touches.length >= 2) begin(event); };
    node.addEventListener?.("scroll", trackScroll, { passive: true });
    if (fullscreen) {
      node.addEventListener?.("touchstart", begin, { passive: false });
      node.addEventListener?.("touchmove", move, { passive: false });
      node.addEventListener?.("touchend", end);
      node.addEventListener?.("touchcancel", end);
    }
    attachment.current = { node, fullscreen, cleanup() {
      node.removeEventListener?.("scroll", trackScroll);
      node.removeEventListener?.("touchstart", begin);
      node.removeEventListener?.("touchmove", move);
      node.removeEventListener?.("touchend", end);
      node.removeEventListener?.("touchcancel", end);
      gesture = null;
    } };
  });
  useEffect(() => () => {
    attachment.current?.cleanup();
    attachment.current = null;
  }, []);

  return { zoom, setZoom, resetZoom };
}
