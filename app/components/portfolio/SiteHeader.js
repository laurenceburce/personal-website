import ThemeSwitch from "./ThemeSwitch";

export default function SiteHeader({
  navItems,
  menuOpen,
  theme,
  activeSectionId,
  onThemeChange,
  onMenuToggle,
  onMenuClose
}) {
  const navClassName = ["site-nav", menuOpen ? "open" : ""].filter(Boolean).join(" ");

  return (
    <header className="site-header">
      <a href="#home" className="brand">
        Laurence Alec Burce
      </a>
      <ThemeSwitch theme={theme} onChange={onThemeChange} className="mobile-theme-toggle" />
      <button
        className="menu-toggle"
        aria-label="Open menu"
        aria-expanded={menuOpen}
        onClick={onMenuToggle}
        type="button"
      >
        <span />
        <span />
        <span />
      </button>
      <nav className={navClassName} aria-label="Main navigation">
        {navItems.map((item) => (
          <a
            key={item.id}
            href={item.href}
            className={activeSectionId === item.id ? "active" : undefined}
            aria-current={activeSectionId === item.id ? "location" : undefined}
            onClick={onMenuClose}
          >
            {item.label}
          </a>
        ))}
      </nav>
    </header>
  );
}
