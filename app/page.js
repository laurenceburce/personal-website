"use client";

import { useEffect, useRef, useState } from "react";

const skillGroups = [
  {
    title: "Programming Languages",
    items: ["Java", "Python", "C/C++", "JavaScript", "TypeScript"]
  },
  {
    title: "Frontend",
    items: ["React"]
  },
  {
    title: "Backend & Frameworks",
    items: ["Spring Boot", "FastAPI", "Oracle ADF", "REST APIs", "JDBC"]
  },
  {
    title: "Data & Databases",
    items: ["PostgreSQL", "SQL"]
  },
  {
    title: "AI & Automation",
    items: ["Copilot Studio", "Power Platform"]
  },
  {
    title: "Tools & Systems",
    items: ["Git", "Perforce", "Linux", "Windows"]
  }
];

const projects = [
  {
    title: "Brand Compliance Validation Platform",
    description:
      "Built a FastAPI + PostgreSQL platform that automatically reviews social media content for fair housing violations, branding standards, and accessibility issues.",
    tech: ["FastAPI", "PostgreSQL", "Python", "Accessibility"]
  },
  {
    title: "Enterprise AI Assistants",
    description:
      "Designed and maintained enterprise-grade AI chatbots and agents for HR, Marketing, and Operations with API-integrated workflows.",
    tech: ["Copilot Studio", "Power Platform", "JavaScript", "Python"]
  },
  {
    title: "AI Chatbot Evaluation Suite",
    description:
      "Designed a chatbot test suite that reduced runtime by more than 90% through concurrent processing and better test orchestration.",
    tech: ["Python", "Automation", "Concurrency", "QA"]
  },
  {
    title: "Spring Social Media Blog API",
    description:
      "Developed a micro-blogging backend with authentication, registration flows, session management, and scalable data access patterns.",
    tech: ["Spring Boot", "JDBC", "JPA", "REST API"],
    link: "https://github.com/laurenceburce/laurenceburce-pep-spring-project"
  }
];

const navItems = [
  { id: "about", href: "#about", label: "About", number: "01", icon: "user" },
  { id: "work", href: "#work", label: "Work Experience", number: "02", icon: "briefcase" },
  { id: "education", href: "#education", label: "Education", number: "03", icon: "cap" },
  { id: "skills", href: "#skills", label: "Skills", number: "04", icon: "spark" },
  { id: "projects", href: "#projects", label: "Projects", number: "05", icon: "briefcase" },
];

const THEME_STORAGE_KEY = "portfolio-theme";

function SidebarIcon({ type }) {
  switch (type) {
    case "user":
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 12a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5Z" stroke="currentColor" strokeWidth="1.8" />
          <path d="M4.5 20.2c1.1-3.1 4-5 7.5-5s6.4 1.9 7.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "spark":
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m12 3 1.8 4.5L18 9.3l-4.2 1.8L12 15.6l-1.8-4.5L6 9.3l4.2-1.8L12 3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      );
    case "briefcase":
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3.5" y="7" width="17" height="12.5" rx="2.2" stroke="currentColor" strokeWidth="1.8" />
          <path d="M9 7V5.7c0-1 .8-1.7 1.7-1.7h2.6c1 0 1.7.8 1.7 1.7V7" stroke="currentColor" strokeWidth="1.8" />
          <path d="M3.5 12h17" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );
    case "cap":
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m3.5 9 8.5-4 8.5 4-8.5 4-8.5-4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M7.5 11.3v3.1c0 1.4 2.1 2.6 4.5 2.6s4.5-1.2 4.5-2.6v-3.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "mail":
      return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3.5" y="5.5" width="17" height="13" rx="2.1" stroke="currentColor" strokeWidth="1.8" />
          <path d="m4.6 7 7.4 5.8L19.4 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return null;
  }
}

const timeline = [
  {
    company: "Maxx Potential",
    period: "May 2025 - Present",
    logoUrl: "/logos/maxx-potential-logo.png",
    logoClass: "maxx",
    location: "San Diego, US (Remote)",
    website: "https://maxxpotential.com",
    roles: [
      {
        title: "AI & Automation Engineer II",
        period: "May 2025 - Present",
        summary: [
          "Built a brand compliance validation platform using FastAPI and PostgreSQL that automatically reviews social media content for fair housing violations, branding standards, and accessibility issues.",
          "Designed and delivered multiple AI-powered internal tools for HHHunt business units, including HR, Marketing, and Operations, improving process efficiency, data accessibility, and decision-making.",
          "Built and maintained enterprise-grade chatbots and AI agents (e.g., HR knowledge assistants, marketing collateral selectors) using Copilot Studio, Power Platform, JavaScript, Python, and API-based integrations.",
          "Designed a test suite for evaluating AI chatbot accuracy, reducing test runtime by over 90% through concurrent processing."
        ]
      }
    ]
  },
  {
    company: "Oracle",
    period: "March 2022 - March 2024",
    logoUrl: "/logos/oracle-logo.png",
    logoClass: "oracle",
    location: "Metro Manila, PH",
    website: "https://www.oracle.com",
    roles: [
      {
        title: "Associate Software Developer",
        period: "September 2022 - March 2024",
        summary: [
          "Developed and maintained RESTful APIs using Java and Spring Boot for enterprise-level applications.",
          "Increased automated test coverage to at least 80%, ensuring code reliability and performance.",
          "Managed SaaS products leveraging Java, SQL, JavaScript, and tools like GIT and Perforce.",
          "Conducted spike investigations to identify scalable solutions for complex technical problems."
        ]
      },
      {
        title: "Graduate Developer",
        period: "March 2022 - September 2022",
        summary: [
          "Gained proficiency in Oracle ERP and Oracle ADF frameworks through intensive training programs.",
          "Resolved customer-related issues by analyzing SQL databases and StackTraces.",
          "Collaborated in Agile Scrum teams using Jira to track project progress and deliverables.",
          "Delivered key contributions to feature development and successful project rollouts."
        ]
      }
    ]
  },
  {
    company: "Yousource Inc.",
    period: "December 2021 - February 2022",
    logoUrl: "/logos/yousource-logo.png",
    logoClass: "yousource",
    location: "Metro Manila, PH",
    website: "https://www.you-source.com",
    roles: [
      {
        title: "Software Engineer Intern",
        period: "December 2021 - February 2022",
        summary: [
          "Designed and executed QA automation tests to improve software quality.",
          "Documented testing procedures for repeatability and smoother knowledge transfer.",
          "Used C++ and Linux Bash scripting for backend QA tasks."
        ]
      }
    ]
  }
];

const monthIndexByName = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11
};

function parseMonthYear(value) {
  const parts = value.trim().toLowerCase().split(/\s+/);
  if (parts.length < 2) return null;

  const monthToken = parts[0].replace(/\./g, "");
  const month = monthIndexByName[monthToken];
  const year = Number(parts[1]);

  if (month === undefined || Number.isNaN(year)) {
    return null;
  }

  return { month, year };
}

function monthStamp(dateParts) {
  return dateParts.year * 12 + dateParts.month;
}

function formatDurationFromPeriod(period) {
  const [startRaw, endRaw] = period.split(" - ").map((value) => value.trim());
  if (!startRaw || !endRaw) return period;

  const start = parseMonthYear(startRaw);
  if (!start) return period;

  let end;
  if (endRaw.toLowerCase() === "present") {
    const now = new Date();
    end = { month: now.getMonth(), year: now.getFullYear() };
  } else {
    end = parseMonthYear(endRaw);
  }

  if (!end) return period;

  const totalMonths = Math.max(1, monthStamp(end) - monthStamp(start));
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;

  if (years > 0 && months > 0) {
    return `${years} year${years === 1 ? "" : "s"} ${months} month${months === 1 ? "" : "s"}`;
  }

  if (years > 0) {
    return `${years} year${years === 1 ? "" : "s"}`;
  }

  return `${months} month${months === 1 ? "" : "s"}`;
}

function particleCountFromWidth(width) {
  if (width > 1600) return 260;
  if (width > 1300) return 220;
  if (width > 1000) return 180;
  if (width > 760) return 130;
  return 90;
}


const sidebarContactInitial = {
  name: "",
  email: "",
  message: "",
  company: ""
};

function validateSidebarContact(values) {
  const errors = {};
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!values.name.trim() || values.name.trim().length < 2) {
    errors.name = "Enter your name.";
  }

  if (!values.email.trim() || !emailPattern.test(values.email.trim())) {
    errors.email = "Enter a valid email.";
  }

  if (!values.message.trim() || values.message.trim().length < 20) {
    errors.message = "Add at least 20 characters.";
  }

  return errors;
}

export default function Home() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState("dark");
  const [themeReady, setThemeReady] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [sidebarOffset, setSidebarOffset] = useState(0);
  const [contactForm, setContactForm] = useState(sidebarContactInitial);
  const [contactErrors, setContactErrors] = useState({});
  const [contactStatus, setContactStatus] = useState({ type: "idle", message: "" });
  const [isContactSubmitting, setIsContactSubmitting] = useState(false);
  const [activeSectionId, setActiveSectionId] = useState(navItems[0].id);
  const canvasRef = useRef(null);
  const contentLayoutRef = useRef(null);
  const sidebarRef = useRef(null);

  useEffect(() => {
    const root = document.documentElement;
    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    const initialTheme =
      savedTheme === "dark" || savedTheme === "light"
        ? savedTheme
        : "dark";

    root.dataset.theme = initialTheme;
    setTheme(initialTheme);
    setThemeReady(true);
  }, []);

  useEffect(() => {
    if (!themeReady) return;

    const root = document.documentElement;
    root.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme, themeReady]);
  useEffect(() => {
    const sectionIds = navItems.map((item) => item.id);
    const sections = sectionIds
      .map((id) => document.getElementById(id))
      .filter(Boolean);

    if (sections.length === 0) {
      return;
    }

    let frameId = 0;

    const updateActiveSection = () => {
      const marker = window.innerHeight * 0.36;
      const nearPageBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 6;

      let currentId = sections[0].id;

      sections.forEach((section) => {
        if (section.getBoundingClientRect().top <= marker) {
          currentId = section.id;
        }
      });

      if (nearPageBottom) {
        currentId = sections[sections.length - 1].id;
      }

      setActiveSectionId((prev) => (prev === currentId ? prev : currentId));
    };

    const requestUpdate = () => {
      if (frameId) return;

      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        updateActiveSection();
      });
    };

    updateActiveSection();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }

      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
    };
  }, []);

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const root = document.documentElement;
    let animationFrame = 0;
    let width = 0;
    let height = 0;

    const pointer = {
      x: window.innerWidth * 0.5,
      y: window.innerHeight * 0.35,
      targetX: window.innerWidth * 0.5,
      targetY: window.innerHeight * 0.35,
      radius: 280,
      targetRadius: 280
    };

    let particles = [];

    const createParticles = () => {
      const count = particleCountFromWidth(width);
      const list = [];

      for (let i = 0; i < count; i += 1) {
        list.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: -0.36 + Math.random() * 0.72,
          vy: -0.36 + Math.random() * 0.72,
          r: 0.75 + Math.random() * 2,
          hue: 207 + Math.random() * 18
        });
      }

      return list;
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
      context.clearRect(0, 0, width, height);

      pointer.x += (pointer.targetX - pointer.x) * 0.14;
      pointer.y += (pointer.targetY - pointer.y) * 0.14;
      pointer.radius += (pointer.targetRadius - pointer.radius) * 0.1;

      root.style.setProperty("--pointer-x", `${pointer.x.toFixed(1)}px`);
      root.style.setProperty("--pointer-y", `${(pointer.y + window.scrollY).toFixed(1)}px`);

      const lineDistance = width > 1200 ? 172 : 146;
      const isLightTheme = root.dataset.theme === "light";

      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];

        if (p.x <= 0 || p.x >= width) {
          p.vx *= -1;
        }
        if (p.y <= 0 || p.y >= height) {
          p.vy *= -1;
        }

        p.x += p.vx;
        p.y += p.vy;

        const pointerDistance = Math.hypot(p.x - pointer.x, p.y - pointer.y);
        const glow = Math.max(0.5, 1.28 - pointerDistance / (width * 0.78));
        const particleAlpha = 0.34 + Math.min(0.48, glow * 0.36) + (isLightTheme ? 0.12 : 0);
        const particleLightness = isLightTheme ? 56 : 62;

        context.beginPath();
        context.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        context.fillStyle = `hsla(${p.hue}, 92%, ${particleLightness}%, ${Math.min(0.97, particleAlpha)})`;
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
          const lineAlpha = lineFade * (0.2 + proximity * 0.65) + (isLightTheme ? 0.12 : 0);
          const lineColor = isLightTheme ? "56, 136, 242" : "78, 153, 255";

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
      pointer.targetRadius = 420;
      root.style.setProperty("--pointer-alpha", "0.26");
    };

    const handleTouchMove = (event) => {
      const touch = event.touches[0];
      if (!touch) return;
      pointer.targetX = touch.clientX;
      pointer.targetY = touch.clientY;
      pointer.targetRadius = 390;
      root.style.setProperty("--pointer-alpha", "0.24");
    };

    const recenterPointer = () => {
      pointer.targetX = window.innerWidth * 0.5;
      pointer.targetY = window.innerHeight * 0.35;
      pointer.targetRadius = 280;
      root.style.setProperty("--pointer-alpha", "0.14");
    };

    resize();
    root.style.setProperty("--pointer-alpha", "0.14");
    animationFrame = window.requestAnimationFrame(draw);

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("pointerleave", recenterPointer);
    window.addEventListener("blur", recenterPointer);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("pointerleave", recenterPointer);
      window.removeEventListener("blur", recenterPointer);
    };
  }, []);

  useEffect(() => {
    let frameId = 0;

    const update = () => {
      const maxScroll =
        document.documentElement.scrollHeight - window.innerHeight;
      const progress = maxScroll > 0 ? window.scrollY / maxScroll : 0;
      setScrollProgress(Math.min(1, Math.max(0, progress)));
    };

    const handleScroll = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        update();
      });
    };

    update();
    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll);

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
    };
  }, []);

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
  }, []);


  const navLinkClass = (id) => (activeSectionId === id ? "active" : undefined);

  const handleThemeSwitchChange = (event) => {
    setTheme(event.target.checked ? "dark" : "light");
  };

  const handleSidebarContactChange = (event) => {
    const { name, value } = event.target;

    setContactForm((prev) => ({
      ...prev,
      [name]: value
    }));

    setContactErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const handleSidebarContactSubmit = async (event) => {
    event.preventDefault();

    const errors = validateSidebarContact(contactForm);

    if (Object.keys(errors).length > 0) {
      setContactErrors(errors);
      setContactStatus({ type: "error", message: "Please fix the form fields." });
      return;
    }

    try {
      setIsContactSubmitting(true);
      setContactStatus({ type: "idle", message: "" });

      const response = await fetch("/api/contact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: contactForm.name,
          email: contactForm.email,
          subject: "Portfolio Sidebar Contact",
          message: contactForm.message,
          company: contactForm.company
        })
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Unable to send message right now.");
      }

      setContactStatus({ type: "success", message: "Message sent." });
      setContactForm(sidebarContactInitial);
      setContactErrors({});
    } catch (error) {
      setContactStatus({
        type: "error",
        message: error.message || "Unable to send message right now."
      });
    } finally {
      setIsContactSubmitting(false);
    }
  };

  return (
    <>
      <canvas ref={canvasRef} className="particle-canvas" aria-hidden="true" />
      <div className="bg-orb orb-left" aria-hidden="true" />
      <div className="bg-orb orb-right" aria-hidden="true" />

      <header className="site-header">
        <a href="#home" className="brand">
          Laurence Alec Burce
        </a>
        <label className="theme-switch mobile-theme-toggle">
          <input
            className="theme-switch-input"
            type="checkbox"
            checked={theme === "dark"}
            onChange={handleThemeSwitchChange}
            aria-label="Toggle dark mode"
          />
          <span className="theme-switch-track" aria-hidden="true">
            <span className="theme-switch-thumb" />
          </span>
          <span className="theme-switch-text">{theme === "dark" ? "Dark" : "Light"}</span>
        </label>
        <button
          className="menu-toggle"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span />
          <span />
          <span />
        </button>
                <nav
          className={`site-nav ${menuOpen ? "open" : ""}`}
          aria-label="Main navigation"
        >
          <a href="#about" className={navLinkClass("about")} aria-current={activeSectionId === "about" ? "location" : undefined} onClick={() => setMenuOpen(false)}>
            About
          </a>
          <a href="#work" className={navLinkClass("work")} aria-current={activeSectionId === "work" ? "location" : undefined} onClick={() => setMenuOpen(false)}>
            Work Experience
          </a>
          <a href="#education" className={navLinkClass("education")} aria-current={activeSectionId === "education" ? "location" : undefined} onClick={() => setMenuOpen(false)}>
            Education
          </a>
          <a href="#skills" className={navLinkClass("skills")} aria-current={activeSectionId === "skills" ? "location" : undefined} onClick={() => setMenuOpen(false)}>
            Skills
          </a>
          <a href="#projects" className={navLinkClass("projects")} aria-current={activeSectionId === "projects" ? "location" : undefined} onClick={() => setMenuOpen(false)}>
            Projects
          </a>
        </nav>
      </header>

      <main id="home" className="main-shell">
        <div className="content-layout" ref={contentLayoutRef}>
          <aside
            ref={sidebarRef}
            className="global-scroll-indicator sidebar-fixed"
            style={{ transform: `translate3d(0, ${sidebarOffset}px, 0)` }}
            aria-label="Section navigation"
          >
            <div className="scroll-profile">
              <p className="scroll-kicker">Quick Navigation</p>
              <a href="#home" className="scroll-brand">
                Laurence Alec Burce
              </a>
              <p className="scroll-role">Software Engineer • AI & Automation Engineer</p>
            </div>
            <nav className="scroll-nav" aria-label="Section navigation">
              {navItems.map((item) => (
                <a
                  key={item.id}
                  href={item.href}
                  className={navLinkClass(item.id)}
                  aria-current={activeSectionId === item.id ? "location" : undefined}
                >
                  <span className="nav-left">
                    <span className="nav-icon">
                      <SidebarIcon type={item.icon} />
                    </span>
                    <span>{item.label}</span>
                  </span>
                  <small>{item.number}</small>
                </a>
              ))}
            </nav>
            <section id="sidebar-contact" className="sidebar-contact">
              <p className="sidebar-contact-title">Contact</p>
              <form className="sidebar-contact-form" onSubmit={handleSidebarContactSubmit} noValidate>
                <input
                  type="text"
                  name="company"
                  value={contactForm.company}
                  onChange={handleSidebarContactChange}
                  className="contact-honeypot"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                />
                <label>
                  <span>Name</span>
                  <input
                    type="text"
                    name="name"
                    value={contactForm.name}
                    onChange={handleSidebarContactChange}
                    aria-invalid={Boolean(contactErrors.name)}
                  />
                </label>
                <label>
                  <span>Email</span>
                  <input
                    type="email"
                    name="email"
                    value={contactForm.email}
                    onChange={handleSidebarContactChange}
                    aria-invalid={Boolean(contactErrors.email)}
                  />
                </label>
                <label>
                  <span>Message</span>
                  <textarea
                    name="message"
                    rows={3}
                    style={{ resize: "none" }}
                    value={contactForm.message}
                    onChange={handleSidebarContactChange}
                    aria-invalid={Boolean(contactErrors.message)}
                  />
                </label>
                <button className="btn btn-primary sidebar-submit" type="submit" disabled={isContactSubmitting}>
                  {isContactSubmitting ? "Sending..." : "Send"}
                </button>
                {contactStatus.message ? (
                  <p
                    className={
                      contactStatus.type === "success"
                        ? "sidebar-contact-status sidebar-contact-status-success"
                        : "sidebar-contact-status sidebar-contact-status-error"
                    }
                  >
                    {contactStatus.message}
                  </p>
                ) : null}
              </form>
              <div className="sidebar-inline-links">
                <a href="mailto:laurenceburce@gmail.com">Email</a>
                <a href="https://github.com/laurenceburce" target="_blank" rel="noreferrer">GitHub</a>
                <a href="https://www.linkedin.com/in/laurence-burce" target="_blank" rel="noreferrer">LinkedIn</a>
              </div>
            </section>
            <label className="theme-switch sidebar-theme-toggle">
              <input
                className="theme-switch-input"
                type="checkbox"
                checked={theme === "dark"}
                onChange={handleThemeSwitchChange}
                aria-label="Toggle dark mode"
              />
              <span className="theme-switch-track" aria-hidden="true">
                <span className="theme-switch-thumb" />
              </span>
              <span className="theme-switch-text">{theme === "dark" ? "Dark" : "Light"}</span>
            </label>
            <div className="indicator-rail" aria-hidden="true">
              <div className="indicator-node">
                <span />
              </div>
              <div className="indicator-track">
                <div
                  className="indicator-progress"
                  style={{ height: `${Math.max(3, scrollProgress * 100)}%` }}
                />
                <div
                  className="indicator-thumb"
                  style={{ top: `${scrollProgress * 100}%` }}
                />
              </div>
            </div>
          </aside>
          <div className="main-sections">
        <section className="hero section reveal">
          <p className="welcome-line">Hello, I'm Laurence.</p>
          <p className="eyebrow">Software Engineer | AI & Automation Engineer</p>
          <h1>
            I'm a software engineer building automation-first systems for modern
            operations teams.
          </h1>
          <p className="lead">
            2+ years of enterprise development experience at Oracle and hands-on
            AI automation delivery for large-scale real estate and property
            management organizations.
          </p>
          <div className="hero-actions">
            <a className="btn btn-primary" href="#projects">
              View Projects
            </a>
            <a
              className="btn btn-secondary"
              href="/Laurence-Alec-Burce-Software-Developer-Resume.pdf"
              download
            >
              Download Resume
            </a>
            <a
              className="btn btn-secondary"
              href="/Laurence-Alec-Burce-Cover-Letter.pdf"
              download
            >
              Download Cover Letter
            </a>
          </div>
        </section>

                <section id="about" className="section reveal">
          <div className="section-head">
            <h2>About</h2>
          </div>
          <div className="about-grid">
            <p>
              I am a Software Engineer with experience across enterprise backend
              services, data pipelines, Oracle ERP systems, and AI-powered
              internal tools. I enjoy translating business problems into
              scalable, reliable systems that improve team productivity.
            </p>
            <p>
              I am based in Santee, California and open to opportunities in San
              Diego or remote roles. I work effectively across technical and
              non-technical teams and focus on delivering solutions with
              measurable impact.
            </p>
          </div>
        </section>

        <section id="work" className="section reveal">
          <div className="section-head">
            <h2>Work Experience</h2>
          </div>
          <div className="timeline">
            {timeline.map((entry) => (
              <article className="timeline-item" key={entry.company}>
                <div className="timeline-grid">
                  <div className="timeline-logo-column">
                    <span className={`brand-mark ${entry.logoClass ? `brand-mark-${entry.logoClass}` : ""}`}>
                      <img src={entry.logoUrl} alt="" aria-hidden="true" loading="lazy" />
                    </span>
                    <div className="timeline-logo-meta">
                      <span>{entry.location}</span>
                      <a href={entry.website} target="_blank" rel="noreferrer">
                        Website
                      </a>
                    </div>
                  </div>
                  <div className="timeline-body">
                    <div className="timeline-head">
                      <h3>{entry.company}</h3>
                      <time>{formatDurationFromPeriod(entry.period)}</time>
                    </div>
                    <div className="timeline-role-list">
                      {entry.roles.map((role) => (
                        <article className="timeline-role-item" key={role.title}>
                          <div className="timeline-role-head">
                            <h4>{role.title}</h4>
                            <time>{role.period}</time>
                          </div>
                          {Array.isArray(role.summary) ? (
                            <ul className="timeline-bullets">
                              {role.summary.map((item) => (
                                <li key={item}>{item}</li>
                              ))}
                            </ul>
                          ) : (
                            <p>{role.summary}</p>
                          )}
                        </article>
                      ))}
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section id="education" className="section reveal">
          <div className="section-head">
            <h2>Education</h2>
          </div>
          <article className="timeline-item">
            <div className="timeline-grid">
              <div className="timeline-logo-column">
                <span className="brand-mark brand-mark-mapua">
                  <img
                    src="/logos/mapua-university-logo.png"
                    alt=""
                    aria-hidden="true"
                    loading="lazy"
                  />
                </span>
                <div className="timeline-logo-meta">
                  <span>Manila, Philippines</span>
                  <a href="https://www.mapua.edu.ph" target="_blank" rel="noreferrer">
                    Website
                  </a>
                </div>
              </div>
              <div className="timeline-body">
                <div className="timeline-head">
                  <h3>Mapua University</h3>
                  <time>{formatDurationFromPeriod("Aug 2017 - Feb 2022")}</time>
                </div>
                <div className="timeline-role-list">
                  <article className="timeline-role-item">
                    <div className="timeline-role-head">
                      <h4>B.S. in Computer Engineering</h4>
                      <time>Aug 2017 - Feb 2022</time>
                    </div>
                    <p>
                      Specialization in HP Unix Administration
                      <br></br>
                      Academic Scholar
                      <br></br>
                      GWA: 2.01 / 1.00
                      <br></br>
                      GPA equivalent ≈ 3.3
                    </p>
                  </article>
                </div>
              </div>
            </div>
          </article>
        </section>

        <section id="skills" className="section reveal">
          <div className="section-head">
            <h2>Skills</h2>
            <p>Core technologies grouped by area of focus.</p>
          </div>
          <div className="skills-groups">
            {skillGroups.map((group) => (
              <article className="skill-group" key={group.title}>
                <h3>{group.title}</h3>
                <ul className="skill-list">
                  {group.items.map((skill) => (
                    <li key={`${group.title}-${skill}`}>{skill}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section id="projects" className="section reveal">
          <div className="section-head">
            <h2>Projects</h2>
            <p>
              Production-focused systems spanning automation, enterprise APIs,
              and internal business tooling.
            </p>
          </div>
          <div className="project-grid">
            {projects.map((project) => (
              <article className="project-card" key={project.title}>
                <h3>{project.title}</h3>
                <p>{project.description}</p>
                {project.link ? (
                  <p>
                    <a href={project.link} target="_blank" rel="noreferrer">
                      View Repository
                    </a>
                  </p>
                ) : null}
                <div className="project-meta">
                  {project.tech.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>

        
          </div>
        </div>
      </main>
    </>
  );
}


































