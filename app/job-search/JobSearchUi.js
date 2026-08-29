"use client";

// Small presentational helpers shared across the job-search panels/tables.
// Finance keeps equivalents inline since it's one 2600-line file; job-search is
// deliberately split into several smaller files, so these live in one shared spot.

export function Field({ label, children }) {
  return (
    <label className="job-search-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Metric({ label, value, tone, detail }) {
  return (
    <div className={`job-search-metric${tone ? ` job-search-metric-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

export function Panel({ title, action, children, className }) {
  return (
    <section className={`job-search-panel${className ? ` ${className}` : ""}`}>
      <header className="job-search-panel-header">
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Badge({ text, tone = "neutral" }) {
  return <span className={`job-search-badge job-search-badge-${tone}`}>{text}</span>;
}

export function scamBadgeTone(level) {
  if (level === "high") return "danger";
  if (level === "medium") return "warn";
  return "neutral";
}

export async function callJobSearchAction(endpoint, action, data) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, data })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || "Something went wrong.");
  return payload.result;
}
