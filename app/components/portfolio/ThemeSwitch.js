function SunIcon() {
  return (
    <svg
      width="11" height="11" viewBox="0 0 16 16"
      fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.75 3.75l1.42 1.42M10.83 10.83l1.42 1.42M12.25 3.75l-1.42 1.42M5.17 10.83l-1.42 1.42" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="11" height="11" viewBox="0 0 16 16"
      fill="currentColor" stroke="none"
      aria-hidden="true"
    >
      <path d="M14.1 10.5a6.5 6.5 0 0 1-8.6-8.6A6.5 6.5 0 1 0 14.1 10.5z" />
    </svg>
  );
}

export default function ThemeSwitch({ theme, onChange, className = "" }) {
  const classes = ["theme-switch", className].filter(Boolean).join(" ");

  return (
    <label className={classes}>
      <input
        className="theme-switch-input"
        type="checkbox"
        checked={theme === "dark"}
        onChange={onChange}
        aria-label="Toggle dark mode"
      />
      <span className="theme-switch-track" aria-hidden="true">
        <span className="toggle-icon toggle-icon-sun"><SunIcon /></span>
        <span className="toggle-icon toggle-icon-moon"><MoonIcon /></span>
        <span className="theme-switch-thumb" />
      </span>
    </label>
  );
}
