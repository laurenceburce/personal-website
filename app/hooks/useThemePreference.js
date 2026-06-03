"use client";

import { useEffect, useState } from "react";

const THEME_STORAGE_KEY = "portfolio-theme";

export default function useThemePreference() {
  const [theme, setTheme] = useState("dark");
  const [themeReady, setThemeReady] = useState(false);

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

  return { theme, setTheme };
}
