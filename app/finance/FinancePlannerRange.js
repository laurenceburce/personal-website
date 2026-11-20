"use client";

import { useEffect, useState } from "react";
import { addDays, formatDate } from "../lib/financePlanner.mjs";
import { getLivePlannerRange } from "../lib/financeLivePlanner.mjs";

export default function FinancePlannerRange({ range, today, minDate, onChange, loading = false }) {
  const [draft, setDraft] = useState(range);
  const [error, setError] = useState("");
  useEffect(() => { setDraft(range); setError(""); }, [range.startDate, range.endDate]);
  const apply = (next) => {
    try {
      const checked = getLivePlannerRange({ ...next, today, minDate });
      setError(""); setDraft(checked); onChange(checked);
    } catch (reason) { setError(reason.message); }
  };
  const upcomingEnd = addDays(today, 90);
  const start = minDate && minDate > addDays(upcomingEnd, -731) ? minDate : addDays(upcomingEnd, -731);
  const presets = (minDate ? [
    [start === minDate ? "From start" : "Recent & upcoming", { startDate: start, endDate: upcomingEnd }],
    ["Next 30 days", { startDate: today, endDate: addDays(today, 30) }],
    ["Next 90 days", { startDate: today, endDate: addDays(today, 90) }],
  ] : [
    ["Past & upcoming", { startDate: addDays(today, -14), endDate: addDays(today, 90) }],
    ["Past 30 days", { startDate: addDays(today, -29), endDate: today }],
    ["Next 30 days", { startDate: today, endDate: addDays(today, 30) }],
    ["Next 90 days", { startDate: today, endDate: addDays(today, 90) }],
  ]).map(([label, value]) => [label, minDate ? getLivePlannerRange({ ...value, today, minDate }) : value]);
  return <section className="fp-live-range" aria-label="Planner date range">
    <div className="fp-live-range-heading"><div><h2>Your timeline</h2><p>{formatDate(range.startDate, { year: "numeric" })} – {formatDate(range.endDate, { year: "numeric" })}</p></div>
      <div className="fp-live-presets" role="group" aria-label="Date range presets">
        {presets.map(([label, value]) => <button key={label} type="button"
          aria-pressed={range.startDate === value.startDate && range.endDate === value.endDate}
          onClick={() => apply(value)}>{label}</button>)}
      </div>
    </div>
    <form className="fp-live-date-form" onSubmit={(event) => { event.preventDefault(); apply(draft); }}>
      <label><span>From</span><input type="date" required min={minDate || "1900-01-01"} max="2200-12-31" value={draft.startDate}
        onChange={(event) => { setDraft((current) => ({ ...current, startDate: event.target.value })); setError(""); }} /></label>
      <span className="fp-live-date-arrow" aria-hidden="true">→</span>
      <label><span>Through</span><input type="date" required min={draft.startDate || "1900-01-01"} max="2200-12-31" value={draft.endDate}
        onChange={(event) => { setDraft((current) => ({ ...current, endDate: event.target.value })); setError(""); }} /></label>
      <button type="submit" className="fp-button fp-secondary">Apply dates</button>
      <small role={loading ? "status" : undefined}>{loading ? "Updating timeline…" : "Changes the view. Your saved transactions stay in place."}</small>
    </form>
    {minDate && <p className="fp-inline-note">Starts {formatDate(minDate, { year: "numeric" })} with known account balances. Earlier activity remains in Transactions.</p>}
    {error && <p className="fp-live-range-error" role="alert">{error}</p>}
  </section>;
}
