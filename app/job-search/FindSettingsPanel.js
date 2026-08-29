"use client";

import { useState } from "react";
import { Field, Panel } from "./JobSearchUi";

const SENIORITY_OPTIONS = ["intern", "junior", "mid", "senior", "staff", "lead", "principal", "director"];

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
    resumeMatchThreshold: findSettings.resumeMatchThreshold ?? 0.55,
    minLlmScore: findSettings.minLlmScore ?? 65,
    excludedCompanies: toCsv(findSettings.excludedCompanies)
  };
}

export default function FindSettingsPanel({ findSettings, saving, onSave }) {
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
      resumeMatchThreshold: Number(form.resumeMatchThreshold),
      minLlmScore: Number(form.minLlmScore),
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

        <div className="job-search-form-actions">
          <button type="submit" disabled={isBusy}>Save find settings</button>
        </div>
      </form>
    </Panel>
  );
}
