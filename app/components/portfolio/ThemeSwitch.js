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
        <span className="toggle-icon toggle-icon-sun">☀</span>
        <span className="toggle-icon toggle-icon-moon">☽</span>
        <span className="theme-switch-thumb" />
      </span>
    </label>
  );
}
