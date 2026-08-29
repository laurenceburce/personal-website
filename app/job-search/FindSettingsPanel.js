"use client";

import { useState } from "react";
import { Field, Panel } from "./JobSearchUi";

const SENIORITY_OPTIONS = ["intern", "junior", "mid", "senior", "staff", "lead", "principal", "director"];

// "engineer"/"developer"/"programmer"/"swe"/"sde" as bare words already subsume
// every more specific phrase ("software engineer", "backend engineer", "staff
// engineer", ...) via the hard filter's word-boundary match — this is the
// broadest net a title-keyword filter can cast without turning it off
// entirely. The LLM rubric stage still down-scores anything irrelevant that
// gets through (e.g. "Sales Engineer"), so over-including here is cheap.
const TITLE_KEYWORD_PRESETS = {
  "Software Engineering (broad)": "engineer, developer, programmer, swe, sde",
  "Everything (no title filter)": ""
};

function toCsv(list) {
  return (list || []).join(", ");
}

function fromCsv(value, maxLength = 120) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean);
}

function toFormState(findSettings) {
  return {
    titleKeywords: toCsv(findSettings.titleKeywords),
    excludeKeywords: toCsv(findSettings.excludeKeywords),
    locations: toCsv(findSettings.locations),
    remotePreference: findSettings.remotePreference || "remote_friendly",
    seniorityLevels: findSettings.seniorityLevels || [],
    salaryFloorUsd: findSettings.salaryFloorUsd ?? "",
    maxPostingAgeHours: findSettings.maxPostingAgeHours ?? 168,
    resumeMatchThreshold: findSettings.resumeMatchThreshold ?? 0.55,
    minLlmScore: findSettings.minLlmScore ?? 65,
    maxLlmCallsPerDay: findSettings.maxLlmCallsPerDay ?? 500,
    retentionDays: findSettings.retentionDays ?? 30,
    discoveryEnabled: findSettings.discoveryEnabled ?? false,
    discoveryLocation: findSettings.discoveryLocation ?? "",
    discoveryCountry: findSettings.discoveryCountry ?? "us",
    discoveryIntervalMinutes: findSettings.discoveryIntervalMinutes ?? 60,
    autoApplyEnabled: findSettings.autoApplyEnabled ?? false,
    autoApplyMinScore: findSettings.autoApplyMinScore ?? 80,
    autoApplyMinMatch: findSettings.autoApplyMinMatch ?? 0.65,
    autoApplyMaxScamRisk: findSettings.autoApplyMaxScamRisk ?? 30,
    autoApplyMaxAgeHours: findSettings.autoApplyMaxAgeHours ?? 24,
    excludedCompanies: toCsv(findSettings.excludedCompanies)
  };
}

export default function FindSettingsPanel({ findSettings, saving, onSave, onRequeueForRescoring }) {
  const [form, setForm] = useState(() => toFormState(findSettings));
  const isBusy = Boolean(saving);

  function toggleSeniority(level) {
    setForm((f) => ({
      ...f,
      seniorityLevels: f.seniorityLevels.includes(level)
        ? f.seniorityLevels.filter((l) => l !== level)
        : [...f.seniorityLevels, level]
    }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    await onSave({
      titleKeywords: fromCsv(form.titleKeywords),
      excludeKeywords: fromCsv(form.excludeKeywords),
      locations: fromCsv(form.locations),
      remotePreference: form.remotePreference,
      seniorityLevels: form.seniorityLevels,
      salaryFloorUsd: form.salaryFloorUsd === "" ? null : Number(form.salaryFloorUsd),
      maxPostingAgeHours: Number(form.maxPostingAgeHours) || 168,
      resumeMatchThreshold: Number(form.resumeMatchThreshold),
      minLlmScore: Number(form.minLlmScore),
      maxLlmCallsPerDay: Number(form.maxLlmCallsPerDay),
      retentionDays: Number(form.retentionDays),
      discoveryEnabled: form.discoveryEnabled,
      discoveryLocation: form.discoveryLocation,
      discoveryCountry: form.discoveryCountry,
      discoveryIntervalMinutes: Number(form.discoveryIntervalMinutes),
      autoApplyEnabled: form.autoApplyEnabled,
      autoApplyMinScore: Number(form.autoApplyMinScore),
      autoApplyMinMatch: Number(form.autoApplyMinMatch),
      autoApplyMaxScamRisk: Number(form.autoApplyMaxScamRisk),
      autoApplyMaxAgeHours: Number(form.autoApplyMaxAgeHours),
      excludedCompanies: fromCsv(form.excludedCompanies, 160)
    });
  }

  return (
    <Panel title="Job Find Settings" className="job-search-find-panel">
      <p className="job-search-panel-hint">
        Controls the hard filters (free, run before anything touches an LLM) and the thresholds that
        decide what reaches your review queue. Changes apply on the next poll — use &quot;Re-score&quot; on a
        posting in the Review Queue to test them against something already collected.
      </p>

      <form onSubmit={handleSubmit} className="job-search-form">
        <Field label="Title keywords (comma-separated, matched against title/department)">
          <div className="job-search-preset-row">
            <span>Presets:</span>
            {Object.entries(TITLE_KEYWORD_PRESETS).map(([label, value]) => (
              <button
                key={label}
                type="button"
                onClick={() => setForm((f) => ({ ...f, titleKeywords: value }))}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            value={form.titleKeywords}
            onChange={(e) => setForm((f) => ({ ...f, titleKeywords: e.target.value }))}
            placeholder="e.g. software engineer, backend, staff engineer"
          />
        </Field>

        <Field label="Exclude keywords (comma-separated)">
          <input
            value={form.excludeKeywords}
            onChange={(e) => setForm((f) => ({ ...f, excludeKeywords: e.target.value }))}
            placeholder="e.g. sales, intern"
          />
        </Field>

        <Field label="Preferred locations (comma-separated, ignored for remote postings)">
          <input
            value={form.locations}
            onChange={(e) => setForm((f) => ({ ...f, locations: e.target.value }))}
            placeholder="e.g. San Diego, Los Angeles"
          />
        </Field>

        <Field label="Remote preference">
          <select
            value={form.remotePreference}
            onChange={(e) => setForm((f) => ({ ...f, remotePreference: e.target.value }))}
          >
            <option value="remote_only">Remote only</option>
            <option value="remote_friendly">Remote-friendly (also match preferred locations)</option>
            <option value="onsite_only">Onsite only</option>
          </select>
        </Field>

        <Field label="Seniority levels (none selected = allow any)">
          <div className="job-search-checkbox-grid">
            {SENIORITY_OPTIONS.map((level) => (
              <label key={level} className="job-search-checkbox">
                <input
                  type="checkbox"
                  checked={form.seniorityLevels.includes(level)}
                  onChange={() => toggleSeniority(level)}
                />
                {level}
              </label>
            ))}
          </div>
        </Field>

        <Field label="Salary floor (USD, only rejects postings that disclose a lower minimum)">
          <input
            type="number"
            min="0"
            value={form.salaryFloorUsd}
            onChange={(e) => setForm((f) => ({ ...f, salaryFloorUsd: e.target.value }))}
            placeholder="e.g. 120000"
          />
        </Field>

        <Field label="Max posting age in hours (default 168 = 7 days; only rejects postings with a known post date)">
          <input
            type="number"
            min="1"
            max="8760"
            value={form.maxPostingAgeHours}
            onChange={(e) => setForm((f) => ({ ...f, maxPostingAgeHours: e.target.value }))}
            placeholder="168"
          />
        </Field>

        <Field label={`Resume match threshold: ${Number(form.resumeMatchThreshold).toFixed(2)} (embedding cosine similarity, 0-1)`}>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={form.resumeMatchThreshold}
            onChange={(e) => setForm((f) => ({ ...f, resumeMatchThreshold: e.target.value }))}
          />
        </Field>

        <Field label={`Minimum score to reach the review queue: ${form.minLlmScore} / 100`}>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={form.minLlmScore}
            onChange={(e) => setForm((f) => ({ ...f, minLlmScore: e.target.value }))}
          />
        </Field>

        <Field label="Excluded companies (comma-separated, exact name match)">
          <input
            value={form.excludedCompanies}
            onChange={(e) => setForm((f) => ({ ...f, excludedCompanies: e.target.value }))}
          />
        </Field>

        <fieldset className="job-search-fieldset">
          <legend>Discovery</legend>
          <p className="job-search-panel-hint">
            Searches by your title keywords above across the web via Adzuna — the only posting source
            this system uses, no company list to maintain. Results that don&apos;t link to a supported
            ATS still get scored and show up in your review queue, just require a manual click to apply.
            Runs on its own schedule below, or on demand via &quot;Run Discovery Now&quot; on the Overview
            tab, since Adzuna&apos;s free tier is far more limited than the direct ATS APIs.
          </p>

          <Field label="Enable discovery">
            <input
              type="checkbox"
              checked={form.discoveryEnabled}
              onChange={(e) => setForm((f) => ({ ...f, discoveryEnabled: e.target.checked }))}
            />
          </Field>

          <Field label="Location (optional, e.g. a city or 'remote')">
            <input
              value={form.discoveryLocation}
              onChange={(e) => setForm((f) => ({ ...f, discoveryLocation: e.target.value }))}
              placeholder="e.g. San Diego"
            />
          </Field>

          <Field label="Country code">
            <select
              value={form.discoveryCountry}
              onChange={(e) => setForm((f) => ({ ...f, discoveryCountry: e.target.value }))}
            >
              {["us", "gb", "ca", "au", "de", "fr", "nl", "in", "sg", "nz", "za", "mx", "br"].map((code) => (
                <option key={code} value={code}>{code.toUpperCase()}</option>
              ))}
            </select>
          </Field>

          <Field label="Minutes between discovery searches (independent of the poll schedule)">
            <input
              type="number"
              min="15"
              value={form.discoveryIntervalMinutes}
              onChange={(e) => setForm((f) => ({ ...f, discoveryIntervalMinutes: e.target.value }))}
            />
          </Field>

          <p className="job-search-panel-hint">
            How many results come back isn&apos;t a separate number to set — each run pages through
            Adzuna&apos;s newest-first results until postings age past the &quot;Max posting age&quot;
            limit above (or a safety ceiling of 500 results, whichever comes first), so it naturally
            pulls more when there&apos;s more fresh volume and less when there isn&apos;t.
          </p>
        </fieldset>

        <fieldset className="job-search-fieldset">
          <legend>Auto-apply</legend>
          <p className="job-search-panel-hint">
            Off by default. When enabled, a posting that already clears the review-queue bar above is
            evaluated against the stricter thresholds below; only if it passes every one of them does the
            system submit it on its own, with nobody in the loop. Anything that doesn&apos;t clear a
            threshold, hits a CAPTCHA or login wall, can&apos;t be resolved to a supported ATS
            (Greenhouse/Lever/Ashby), or has a required field it can&apos;t confidently answer lands in
            Review Queue &rarr; &quot;Skipped auto-apply&quot; with the specific reason instead — never
            silently dropped, and always still approvable by hand from there.
          </p>

          <Field label="Enable auto-apply">
            <input
              type="checkbox"
              checked={form.autoApplyEnabled}
              onChange={(e) => setForm((f) => ({ ...f, autoApplyEnabled: e.target.checked }))}
            />
          </Field>

          <Field label={`Minimum score to auto-apply: ${form.autoApplyMinScore} / 100 (independent of, and normally higher than, the review-queue minimum above)`}>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={form.autoApplyMinScore}
              onChange={(e) => setForm((f) => ({ ...f, autoApplyMinScore: e.target.value }))}
            />
          </Field>

          <Field label={`Minimum resume match to auto-apply: ${Number(form.autoApplyMinMatch).toFixed(2)} (embedding cosine similarity, 0-1)`}>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={form.autoApplyMinMatch}
              onChange={(e) => setForm((f) => ({ ...f, autoApplyMinMatch: e.target.value }))}
            />
          </Field>

          <Field label={`Maximum scam-risk score to auto-apply: ${form.autoApplyMaxScamRisk} / 100`}>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={form.autoApplyMaxScamRisk}
              onChange={(e) => setForm((f) => ({ ...f, autoApplyMaxScamRisk: e.target.value }))}
            />
          </Field>

          <Field label="Only auto-apply to postings newer than this many hours">
            <input
              type="number"
              min="1"
              max="8760"
              value={form.autoApplyMaxAgeHours}
              onChange={(e) => setForm((f) => ({ ...f, autoApplyMaxAgeHours: e.target.value }))}
            />
          </Field>
        </fieldset>

        <fieldset className="job-search-fieldset">
          <legend>Safety nets</legend>
          <p className="job-search-panel-hint">
            Hard, code-enforced ceilings — independent of whatever quota/plan your Gemini key or MySQL
            volume actually has. These exist so an unexpected backlog can&apos;t silently run up cost
            or fill your database again.
          </p>

          <Field label="Max Gemini calls per day (embedding + scoring combined)">
            <input
              type="number"
              min="1"
              value={form.maxLlmCallsPerDay}
              onChange={(e) => setForm((f) => ({ ...f, maxLlmCallsPerDay: e.target.value }))}
            />
          </Field>

          <Field label="Delete filtered-out / rejected / closed / scored-low postings after this many days">
            <input
              type="number"
              min="1"
              value={form.retentionDays}
              onChange={(e) => setForm((f) => ({ ...f, retentionDays: e.target.value }))}
            />
          </Field>
        </fieldset>

        <div className="job-search-form-actions">
          <button type="submit" disabled={isBusy}>Save find settings</button>
        </div>
      </form>

      <fieldset className="job-search-fieldset">
        <legend>Re-score existing postings</legend>
        <p className="job-search-panel-hint">
          Changed a filter or threshold above and want it applied retroactively, not just to newly
          discovered postings? This resets every filtered-out, below-threshold, and scored-low posting
          back to &quot;new&quot; so the next scoring run (cron, or &quot;Score New Postings Now&quot; on
          the Overview tab) re-evaluates them against your current settings. Postings you&apos;ve
          already approved, rejected, or applied to are left alone.
        </p>
        <div className="job-search-form-actions">
          <button type="button" disabled={isBusy} onClick={onRequeueForRescoring}>
            {saving === "requeueForRescoring" ? "Requeuing..." : "Re-score filtered / low-scored postings"}
          </button>
        </div>
      </fieldset>
    </Panel>
  );
}
