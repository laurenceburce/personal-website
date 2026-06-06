"use client";

import { useEffect, useRef } from "react";

function particleCountFromWidth(width) {
  if (width > 1600) return 240;
  if (width > 1300) return 200;
  if (width > 1000) return 165;
  if (width > 760)  return 120;
  return 80;
}

export default function BackgroundEffects() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    // Respect prefers-reduced-motion — skip animation entirely.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const root = document.documentElement;
    let animationFrame = 0;
    let width = 0;
    let height = 0;
    let baseParticleCount = 0;
    let paused = false;

    const pointer = {
      x: window.innerWidth * 0.5,
      y: window.innerHeight * 0.35,
      targetX: window.innerWidth * 0.5,
      targetY: window.innerHeight * 0.35,
      radius: 150,
      targetRadius: 150,
      active: false,
    };

    let particles = [];
    let tick = 0;

    // Each particle carries a depth value (0–1): deeper particles are smaller,
    // slower, and slightly dimmer — giving a subtle parallax depth effect.
    const createParticle = (overrides = {}) => {
      const depth = Math.random(); // 0 = far, 1 = near
      const baseR  = 0.5 + depth * 1.8;
      const speed  = 0.08 + depth * 0.18;
      const angle  = Math.random() * Math.PI * 2;
      // Hue blends from cool blue-purple (200) for deep particles to
      // bright cyan (188) for near particles — harmonises with --accent.
      const hue = 195 + (1 - depth) * 30 + Math.random() * 12;

      return {
        x: Math.random() * width,
        y: Math.random() * height,
        vx: Math.cos(angle) * speed * (0.5 + Math.random() * 0.5),
        vy: Math.sin(angle) * speed * (0.5 + Math.random() * 0.5),
        r: baseR,
        depth,
        hue,
        sat: 75 + depth * 20,
        alpha: 0,
        repelAfter: 0,
        ...overrides,
      };
    };

    const createParticles = () => {
      baseParticleCount = particleCountFromWidth(width);
      return Array.from({ length: baseParticleCount }, () => createParticle());
    };

    const refillPointerSpace = () => {
      if (!pointer.active || width <= 0 || height <= 0) return;

      const refillRadius = pointer.radius * 0.92;
      const areaRatio = Math.min(
        1,
        (Math.PI * refillRadius * refillRadius) / (width * height)
      );
      const desiredNearby = Math.max(5, Math.ceil(baseParticleCount * areaRatio * 0.72));
      let nearby = 0;

      for (let i = 0; i < particles.length; i++) {
        if (Math.hypot(particles[i].x - pointer.x, particles[i].y - pointer.y) < refillRadius) {
          nearby++;
        }
      }

      const maxParticles = baseParticleCount + Math.max(24, Math.round(baseParticleCount * 0.24));
      const refillCount = Math.min(3, desiredNearby - nearby, maxParticles - particles.length);
      if (refillCount <= 0) return;

      for (let i = 0; i < refillCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.sqrt(Math.random()) * refillRadius;
        const scatter = i === refillCount - 1 && particles.length > baseParticleCount;

        particles.push(
          createParticle({
            x: scatter ? Math.random() * width  : Math.min(width,  Math.max(0, pointer.x + Math.cos(angle) * dist)),
            y: scatter ? Math.random() * height : Math.min(height, Math.max(0, pointer.y + Math.sin(angle) * dist)),
            vx: scatter
              ? -0.15 + Math.random() * 0.3
              : Math.cos(angle) * (0.04 + Math.random() * 0.08) + (-0.08 + Math.random() * 0.16),
            vy: scatter
              ? -0.15 + Math.random() * 0.3
              : Math.sin(angle) * (0.04 + Math.random() * 0.08) + (-0.08 + Math.random() * 0.16),
            alpha: 0.12,
            repelAfter: tick + 34,
          })
        );
      }
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      width  = window.innerWidth;
      height = window.innerHeight;
      canvas.width  = Math.floor(width  * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width  = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      particles = createParticles();
    };

    const draw = () => {
      if (paused) return;

      tick++;
      context.clearRect(0, 0, width, height);

      pointer.x += (pointer.targetX - pointer.x) * 0.12;
      pointer.y += (pointer.targetY - pointer.y) * 0.12;
      pointer.radius += (pointer.targetRadius - pointer.radius) * 0.1;
      refillPointerSpace();

      root.style.setProperty("--pointer-x", `${pointer.x.toFixed(1)}px`);
      root.style.setProperty(
        "--pointer-y",
        `${(pointer.y + window.scrollY).toFixed(1)}px`
      );

      const lineDistance    = width > 1200 ? 168 : 142;
      const separationDist  = width > 760  ? 32  : 26;
      const isLightTheme    = root.dataset.theme === "light";

      // ── Particle physics ──────────────────────────────────────────────
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a  = particles[i];
          const b  = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d  = Math.hypot(dx, dy);

          if (d <= 0.001 || d > separationDist) continue;

          const pressure = (1 - d / separationDist) * 0.018;
          const fx = (dx / d) * pressure;
          const fy = (dy / d) * pressure;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }

      // ── Particle render ───────────────────────────────────────────────
      for (let i = 0; i < particles.length; i++) {
        const p  = particles[i];
        const dxP = p.x - pointer.x;
        const dyP = p.y - pointer.y;
        const pointerDist = Math.hypot(dxP, dyP);

        // Cursor repulsion
        if (
          pointer.active &&
          tick >= p.repelAfter &&
          pointerDist < pointer.radius &&
          pointerDist > 0.001
        ) {
          const prox = 1 - pointerDist / pointer.radius;
          const push = prox * prox * 0.72;
          p.vx += (dxP / pointerDist) * push;
          p.vy += (dyP / pointerDist) * push;
        }

        // Random walk
        p.vx += (-0.2 + Math.random() * 0.4) * 0.005;
        p.vy += (-0.2 + Math.random() * 0.4) * 0.005;

        // Dampen — deeper (slower) particles damp more
        const damp = 0.990 - p.depth * 0.004;
        p.vx *= damp;
        p.vy *= damp;

        const speed = Math.hypot(p.vx, p.vy);
        const minSpeed = 0.05 + p.depth * 0.04;
        const maxSpeed = pointer.active ? 1.4 : 0.44 + p.depth * 0.12;

        if (speed > maxSpeed) {
          p.vx = (p.vx / speed) * maxSpeed;
          p.vy = (p.vy / speed) * maxSpeed;
        } else if (speed < minSpeed) {
          const a2 = Math.random() * Math.PI * 2;
          p.vx += Math.cos(a2) * minSpeed;
          p.vy += Math.sin(a2) * minSpeed;
        }

        if (p.x <= 0 || p.x >= width)  p.vx *= -1;
        if (p.y <= 0 || p.y >= height) p.vy *= -1;

        p.x += p.vx;
        p.y += p.vy;
        p.alpha += (1 - p.alpha) * 0.04;

        // Glow boost near cursor — near particles glow more
        const glowBoost = Math.max(0, 1.3 - pointerDist / (width * 0.7)) * p.depth;
        const baseAlpha = 0.28 + p.depth * 0.42 + glowBoost * 0.28;
        const particleAlpha = Math.min(0.97, baseAlpha * p.alpha + (isLightTheme ? 0.06 : 0));
        const lightness = isLightTheme ? 38 : 58 + p.depth * 12;

        const color = isLightTheme
          ? `rgba(44, 44, 44, ${Math.min(0.7, particleAlpha).toFixed(3)})`
          : `hsla(${p.hue}, ${p.sat}%, ${lightness}%, ${particleAlpha.toFixed(3)})`;

        // Draw particle with soft radial glow for near particles
        if (!isLightTheme && p.depth > 0.6 && p.r > 1.2) {
          const grad = context.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 2.2);
          grad.addColorStop(0, `hsla(${p.hue}, ${p.sat}%, ${lightness + 10}%, ${particleAlpha.toFixed(3)})`);
          grad.addColorStop(1, `hsla(${p.hue}, ${p.sat}%, ${lightness}%, 0)`);
          context.beginPath();
          context.arc(p.x, p.y, p.r * 2.2, 0, Math.PI * 2);
          context.fillStyle = grad;
          context.fill();
        }

        context.beginPath();
        context.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        context.fillStyle = color;
        context.fill();
      }

      // ── Connection lines ──────────────────────────────────────────────
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a  = particles[i];
          const b  = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d  = Math.hypot(dx, dy);

          if (d > lineDistance) continue;

          // Lines between particles of similar depth are brighter
          const depthSimilarity = 1 - Math.abs(a.depth - b.depth);
          const da   = Math.hypot(a.x - pointer.x, a.y - pointer.y);
          const db   = Math.hypot(b.x - pointer.x, b.y - pointer.y);
          const prox = 1 - Math.min(1, Math.min(da, db) / (pointer.radius * 1.35));
          const fade = 1 - d / lineDistance;
          const lineAlpha =
            fade *
            (0.14 + prox * 0.58 + depthSimilarity * 0.1 + (isLightTheme ? 0.06 : 0)) *
            Math.min(a.alpha, b.alpha);

          const lineColor = isLightTheme ? "54, 54, 54" : "78, 153, 255";
          const lineWidth = prox > 0.25
            ? (isLightTheme ? 1.35 : 1.28)
            : (isLightTheme ? 1.05 : 1.0);

          context.beginPath();
          context.moveTo(a.x, a.y);
          context.lineTo(b.x, b.y);
          context.strokeStyle = `rgba(${lineColor}, ${Math.min(0.92, lineAlpha).toFixed(3)})`;
          context.lineWidth   = lineWidth;
          context.stroke();
        }
      }

      animationFrame = window.requestAnimationFrame(draw);
    };

    // ── Event handlers ────────────────────────────────────────────────
    const handlePointerMove = (e) => {
      pointer.targetX = e.clientX;
      pointer.targetY = e.clientY;
      pointer.targetRadius = 170;
      pointer.active = true;
      root.style.setProperty("--pointer-alpha", "0.26");
    };

    const handlePointerDown = (e) => {
      pointer.targetX = e.clientX;
      pointer.targetY = e.clientY;
      pointer.targetRadius = 195;
      pointer.active = true;
      root.style.setProperty("--pointer-alpha", "0.3");
    };

    const handlePointerUp = () => {
      pointer.targetRadius = 150;
      root.style.setProperty("--pointer-alpha", "0.22");
    };

    const handleTouchMove = (e) => {
      const touch = e.touches[0];
      if (!touch) return;
      pointer.targetX = touch.clientX;
      pointer.targetY = touch.clientY;
      pointer.targetRadius = 170;
      pointer.active = true;
      root.style.setProperty("--pointer-alpha", "0.24");
    };

    const recenterPointer = () => {
      pointer.targetX = window.innerWidth * 0.5;
      pointer.targetY = window.innerHeight * 0.35;
      pointer.targetRadius = 150;
      pointer.active = false;
      root.style.setProperty("--pointer-alpha", "0.14");
    };

    // Pause animation when the tab is hidden to save CPU.
    const handleVisibilityChange = () => {
      if (document.hidden) {
        paused = true;
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      } else {
        paused = false;
        animationFrame = window.requestAnimationFrame(draw);
      }
    };

    // ── Init ──────────────────────────────────────────────────────────
    resize();
    root.style.setProperty("--pointer-alpha", "0.14");
    animationFrame = window.requestAnimationFrame(draw);

    window.addEventListener("resize",       resize);
    window.addEventListener("pointermove",  handlePointerMove,  { passive: true });
    window.addEventListener("pointerdown",  handlePointerDown,  { passive: true });
    window.addEventListener("pointerup",    handlePointerUp,    { passive: true });
    window.addEventListener("touchmove",    handleTouchMove,    { passive: true });
    window.addEventListener("pointerleave", recenterPointer);
    window.addEventListener("blur",         recenterPointer);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize",       resize);
      window.removeEventListener("pointermove",  handlePointerMove);
      window.removeEventListener("pointerdown",  handlePointerDown);
      window.removeEventListener("pointerup",    handlePointerUp);
      window.removeEventListener("touchmove",    handleTouchMove);
      window.removeEventListener("pointerleave", recenterPointer);
      window.removeEventListener("blur",         recenterPointer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="particle-canvas" aria-hidden="true" />
      <div className="bg-orb orb-left"  aria-hidden="true" />
      <div className="bg-orb orb-right" aria-hidden="true" />
    </>
  );
}
