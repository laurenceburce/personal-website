"use client";

import { useEffect, useRef } from "react";

function particleCountFromWidth(width) {
  if (width > 1600) return 260;
  if (width > 1300) return 220;
  if (width > 1000) return 180;
  if (width > 760) return 130;
  return 90;
}

export default function BackgroundEffects() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const root = document.documentElement;
    let animationFrame = 0;
    let width = 0;
    let height = 0;
    let baseParticleCount = 0;

    const pointer = {
      x: window.innerWidth * 0.5,
      y: window.innerHeight * 0.35,
      targetX: window.innerWidth * 0.5,
      targetY: window.innerHeight * 0.35,
      radius: 150,
      targetRadius: 150,
      active: false
    };

    let particles = [];
    let tick = 0;

    const createParticle = (overrides = {}) => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: -0.2 + Math.random() * 0.4,
      vy: -0.2 + Math.random() * 0.4,
      r: 0.75 + Math.random() * 2,
      hue: 188 + Math.random() * 32,
      alpha: 1,
      repelAfter: 0,
      ...overrides
    });

    const createParticles = () => {
      baseParticleCount = particleCountFromWidth(width);
      const list = [];

      for (let i = 0; i < baseParticleCount; i += 1) {
        list.push(createParticle());
      }

      return list;
    };

    const refillPointerSpace = () => {
      if (!pointer.active || width <= 0 || height <= 0) return;

      const refillRadius = pointer.radius * 0.92;
      const areaRatio = Math.min(1, (Math.PI * refillRadius * refillRadius) / (width * height));
      const desiredNearby = Math.max(5, Math.ceil(baseParticleCount * areaRatio * 0.72));
      let nearby = 0;

      for (let i = 0; i < particles.length; i += 1) {
        const particle = particles[i];
        if (Math.hypot(particle.x - pointer.x, particle.y - pointer.y) < refillRadius) {
          nearby += 1;
        }
      }

      const maxParticles = baseParticleCount + Math.max(24, Math.round(baseParticleCount * 0.24));
      const refillCount = Math.min(3, desiredNearby - nearby, maxParticles - particles.length);
      if (refillCount <= 0) return;

      for (let i = 0; i < refillCount; i += 1) {
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.sqrt(Math.random()) * refillRadius;
        const shouldScatter = i === refillCount - 1 && particles.length > baseParticleCount;
        particles.push(createParticle({
          x: shouldScatter ? Math.random() * width : Math.min(width, Math.max(0, pointer.x + Math.cos(angle) * distance)),
          y: shouldScatter ? Math.random() * height : Math.min(height, Math.max(0, pointer.y + Math.sin(angle) * distance)),
          vx: shouldScatter
            ? -0.2 + Math.random() * 0.4
            : Math.cos(angle) * (0.04 + Math.random() * 0.08) + (-0.08 + Math.random() * 0.16),
          vy: shouldScatter
            ? -0.2 + Math.random() * 0.4
            : Math.sin(angle) * (0.04 + Math.random() * 0.08) + (-0.08 + Math.random() * 0.16),
          r: 0.65 + Math.random() * 1.55,
          alpha: 0.16,
          repelAfter: tick + 34
        }));
      }
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      particles = createParticles();
    };

    const draw = () => {
      tick += 1;
      context.clearRect(0, 0, width, height);

      pointer.x += (pointer.targetX - pointer.x) * 0.14;
      pointer.y += (pointer.targetY - pointer.y) * 0.14;
      pointer.radius += (pointer.targetRadius - pointer.radius) * 0.1;
      refillPointerSpace();

      root.style.setProperty("--pointer-x", `${pointer.x.toFixed(1)}px`);
      root.style.setProperty("--pointer-y", `${(pointer.y + window.scrollY).toFixed(1)}px`);

      const lineDistance = width > 1200 ? 172 : 146;
      const separationDistance = width > 760 ? 34 : 28;
      const isLightTheme = root.dataset.theme === "light";

      for (let i = 0; i < particles.length; i += 1) {
        for (let j = i + 1; j < particles.length; j += 1) {
          const a = particles[i];
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distance = Math.hypot(dx, dy);

          if (distance <= 0.001 || distance > separationDistance) continue;

          const pressure = (1 - distance / separationDistance) * 0.018;
          const forceX = (dx / distance) * pressure;
          const forceY = (dy / distance) * pressure;

          a.vx += forceX;
          a.vy += forceY;
          b.vx -= forceX;
          b.vy -= forceY;
        }
      }

      for (let i = 0; i < particles.length; i += 1) {
        const particle = particles[i];
        const dxFromPointer = particle.x - pointer.x;
        const dyFromPointer = particle.y - pointer.y;
        const pointerDistance = Math.hypot(dxFromPointer, dyFromPointer);

        if (pointer.active && tick >= particle.repelAfter && pointerDistance < pointer.radius && pointerDistance > 0.001) {
          const proximity = 1 - pointerDistance / pointer.radius;
          const push = proximity * proximity * 0.7;
          particle.vx += (dxFromPointer / pointerDistance) * push;
          particle.vy += (dyFromPointer / pointerDistance) * push;
        }

        particle.vx += (-0.2 + Math.random() * 0.4) * 0.006;
        particle.vy += (-0.2 + Math.random() * 0.4) * 0.006;

        particle.vx *= 0.992;
        particle.vy *= 0.992;

        const speed = Math.hypot(particle.vx, particle.vy);
        const minSpeed = 0.08;
        const maxSpeed = pointer.active ? 1.5 : 0.5;
        if (speed > maxSpeed) {
          particle.vx = (particle.vx / speed) * maxSpeed;
          particle.vy = (particle.vy / speed) * maxSpeed;
        } else if (speed < minSpeed) {
          const angle = Math.random() * Math.PI * 2;
          particle.vx += Math.cos(angle) * minSpeed;
          particle.vy += Math.sin(angle) * minSpeed;
        }

        if (particle.x <= 0 || particle.x >= width) {
          particle.vx *= -1;
        }
        if (particle.y <= 0 || particle.y >= height) {
          particle.vy *= -1;
        }

        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.alpha += (1 - particle.alpha) * 0.045;

        const glow = Math.max(0.5, 1.28 - pointerDistance / (width * 0.78));
        const particleAlpha = (0.34 + Math.min(0.48, glow * 0.36) + (isLightTheme ? 0.1 : 0)) * particle.alpha;
        const particleLightness = isLightTheme ? 42 : 62;
        const particleColor = isLightTheme
          ? `rgba(54, 54, 54, ${Math.min(0.74, particleAlpha).toFixed(3)})`
          : `hsla(${particle.hue}, 92%, ${particleLightness}%, ${Math.min(0.97, particleAlpha)})`;

        context.beginPath();
        context.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
        context.fillStyle = particleColor;
        context.fill();
      }

      for (let i = 0; i < particles.length; i += 1) {
        for (let j = i + 1; j < particles.length; j += 1) {
          const a = particles[i];
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distance = Math.hypot(dx, dy);

          if (distance > lineDistance) continue;

          const da = Math.hypot(a.x - pointer.x, a.y - pointer.y);
          const db = Math.hypot(b.x - pointer.x, b.y - pointer.y);
          const proximity = 1 - Math.min(1, Math.min(da, db) / (pointer.radius * 1.35));
          const lineFade = 1 - distance / lineDistance;
          const lineAlpha = (lineFade * (0.2 + proximity * 0.65) + (isLightTheme ? 0.08 : 0)) * Math.min(a.alpha, b.alpha);
          const lineColor = isLightTheme ? "54, 54, 54" : "78, 153, 255";

          context.beginPath();
          context.moveTo(a.x, a.y);
          context.lineTo(b.x, b.y);
          context.strokeStyle = `rgba(${lineColor}, ${Math.min(0.97, lineAlpha).toFixed(3)})`;
          context.lineWidth = proximity > 0.2 ? (isLightTheme ? 1.42 : 1.35) : (isLightTheme ? 1.12 : 1.05);
          context.stroke();
        }
      }

      animationFrame = window.requestAnimationFrame(draw);
    };

    const handlePointerMove = (event) => {
      pointer.targetX = event.clientX;
      pointer.targetY = event.clientY;
      pointer.targetRadius = 170;
      pointer.active = true;
      root.style.setProperty("--pointer-alpha", "0.26");
    };

    const handlePointerDown = (event) => {
      pointer.targetX = event.clientX;
      pointer.targetY = event.clientY;
      pointer.targetRadius = 190;
      pointer.active = true;
      root.style.setProperty("--pointer-alpha", "0.3");
    };

    const handlePointerUp = () => {
      pointer.targetRadius = 150;
      root.style.setProperty("--pointer-alpha", "0.22");
    };

    const handleTouchMove = (event) => {
      const touch = event.touches[0];
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

    resize();
    root.style.setProperty("--pointer-alpha", "0.14");
    animationFrame = window.requestAnimationFrame(draw);

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerdown", handlePointerDown, { passive: true });
    window.addEventListener("pointerup", handlePointerUp, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("pointerleave", recenterPointer);
    window.addEventListener("blur", recenterPointer);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("pointerleave", recenterPointer);
      window.removeEventListener("blur", recenterPointer);
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="particle-canvas" aria-hidden="true" />
      <div className="bg-orb orb-left" aria-hidden="true" />
      <div className="bg-orb orb-right" aria-hidden="true" />
    </>
  );
}
