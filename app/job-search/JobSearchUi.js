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

const ATS_TYPE_LABELS = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workable: "Workable",
  recruitee: "Recruitee",
  personio: "Personio",
  breezy: "Breezy HR",
  smartrecruiters: "SmartRecruiters",
  workday: "Workday",
  icims: "iCIMS",
  oracle_fusion: "Oracle Recruiting Cloud",
  oracle_taleo: "Oracle/Taleo (legacy)",
  // Adzuna-sourced postings are stored with ats_type='external' until
  // something actually resolves the real platform (auto-apply, or a human
  // approving it) — labeled "Adzuna" (not the generic "External" fallback
  // below) so the source is obvious at a glance, distinct from a posting
  // found via direct-poll of a company's own board.
  external: "Adzuna"
};

// Link text for "go to the actual posting" — shows which ATS it's really on
// (or which discovery source, for an unresolved one) instead of a generic
// "Posting" label. The bare "External" fallback is only for a genuinely
// unmapped/unexpected ats_type value, not the normal Adzuna case above.
export function atsTypeLabel(atsType) {
  return ATS_TYPE_LABELS[atsType] || "External";
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
