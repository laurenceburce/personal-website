"use client";

import { useRef, useState } from "react";
import { Badge, Field, Panel } from "./JobSearchUi";

const GENDER_OPTIONS = ["Male", "Female", "Decline to self-identify"];
const RACE_OPTIONS = [
  "Hispanic or Latino",
  "White",
  "Black or African American",
  "Native Hawaiian or Other Pacific Islander",
  "Asian",
  "American Indian or Alaska Native",
  "Two or More Races",
  "Decline to self-identify"
];
const VETERAN_OPTIONS = [
  "I am not a protected veteran",
  "I identify as one or more of the classifications of a protected veteran",
  "I don't wish to answer"
];
const DISABILITY_OPTIONS = [
  "Yes, I have a disability, or have had one in the past",
  "No, I do not have a disability and have not had one in the past",
  "I do not want to answer"
];

function emptyWorkEntry() {
  return { company: "", title: "", location: "", startDate: "", endDate: "", current: false, description: "" };
}

function emptyEducationEntry() {
  return { school: "", degree: "", field: "", startDate: "", endDate: "" };
}

function emptyLinkEntry() {
  return { label: "", url: "" };
}

function toFormState(profile) {
  return {
    prefix: profile.prefix || "",
    firstName: profile.firstName || "",
    middleName: profile.middleName || "",
    lastName: profile.lastName || "",
    suffix: profile.suffix || "",
    email: profile.email || "",
    phone: profile.phone || "",
    addressLine1: profile.addressLine1 || "",
    city: profile.city || "",
    stateRegion: profile.stateRegion || "",
    postalCode: profile.postalCode || "",
    country: profile.country || "",
    linkedinUrl: profile.linkedinUrl || "",
    githubUrl: profile.githubUrl || "",
    portfolioUrl: profile.portfolioUrl || "",
    otherLinks: profile.otherLinks?.length ? profile.otherLinks : [],
    workHistory: profile.workHistory?.length ? profile.workHistory : [],
    education: profile.education?.length ? profile.education : [],
    workAuthorization: {
      authorizedInCountry: profile.workAuthorization?.authorizedInCountry || "",
      requiresSponsorship: profile.workAuthorization?.requiresSponsorship || "",
      country: profile.workAuthorization?.country || ""
    },
    eeoAnswers: {
      gender: profile.eeoAnswers?.gender || "",
      raceEthnicity: profile.eeoAnswers?.raceEthnicity || "",
      veteranStatus: profile.eeoAnswers?.veteranStatus || "",
      disabilityStatus: profile.eeoAnswers?.disabilityStatus || ""
    },
    coverLetterTemplate: profile.coverLetterTemplate || ""
  };
}

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  return `${Math.round(bytes / 1024)} KB`;
}

export default function ProfileSettingsPanel({ profile, resumes, saving, onSaveProfile, onUploadResume, onSetDefaultResume, onDeleteResume }) {
  const [form, setForm] = useState(() => toFormState(profile));
  const [resumeLabel, setResumeLabel] = useState("");
  const fileInputRef = useRef(null);
  const isBusy = Boolean(saving);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }
  function setNested(section, field, value) {
    setForm((f) => ({ ...f, [section]: { ...f[section], [field]: value } }));
  }

  function updateListItem(listKey, index, patch) {
    setForm((f) => ({
      ...f,
      [listKey]: f[listKey].map((item, i) => (i === index ? { ...item, ...patch } : item))
    }));
  }
  function addListItem(listKey, factory) {
    setForm((f) => ({ ...f, [listKey]: [...f[listKey], factory()] }));
  }
  function removeListItem(listKey, index) {
    setForm((f) => ({ ...f, [listKey]: f[listKey].filter((_, i) => i !== index) }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    await onSaveProfile(form);
  }

  async function handleResumeUpload(event) {
    event.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);
    formData.append("label", resumeLabel || file.name);
    formData.append("makeDefault", resumes.length === 0 ? "true" : "false");

    await onUploadResume(formData);
    setResumeLabel("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <>
      <Panel title="Resumes" className="job-search-resumes-panel">
        <p className="job-search-panel-hint">
          PDF resumes get automatic text extraction, used to match against postings and build the LLM
          scoring context. Other file types are stored for use during autofill but won&apos;t inform matching.
        </p>

        {resumes.length === 0 ? (
          <p className="job-search-empty">No resumes uploaded yet.</p>
        ) : (
          <ul className="job-search-resume-list">
            {resumes.map((resume) => (
              <li key={resume.id} className="job-search-resume-row">
                <div>
                  <strong>{resume.label}</strong>
                  <span className="job-search-cell-note">{resume.fileName} · {formatBytes(resume.fileSize)}</span>
                </div>
                {resume.isDefault ? <Badge text="Default" tone="success" /> : (
                  <button type="button" disabled={isBusy} onClick={() => onSetDefaultResume(resume.id)}>Make default</button>
                )}
                <button type="button" disabled={isBusy} onClick={() => onDeleteResume(resume.id)}>Delete</button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={handleResumeUpload} className="job-search-form job-search-inline-form">
          <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx" required />
          <input
            type="text"
            placeholder="Label (optional)"
            value={resumeLabel}
            onChange={(e) => setResumeLabel(e.target.value)}
          />
          <button type="submit" disabled={isBusy}>Upload resume</button>
        </form>
      </Panel>

      <Panel title="Profile / Autofill Fields" className="job-search-profile-panel">
        <form onSubmit={handleSubmit} className="job-search-form">
          <p className="job-search-panel-hint">
            Entered as separate fields (not one "Full name" box) so forms that ask for First/Middle/Last
            separately can be filled correctly — splitting a single typed name back into parts isn't
            reliable in general (e.g. a two-word first name looks identical to a first + middle name).
          </p>
          <div className="job-search-field-grid">
            <Field label="Prefix (optional)"><input placeholder="Mr., Dr., …" value={form.prefix} onChange={(e) => set("prefix", e.target.value)} /></Field>
            <Field label="First name"><input value={form.firstName} onChange={(e) => set("firstName", e.target.value)} /></Field>
            <Field label="Middle name"><input placeholder="Full middle name, not just the initial" value={form.middleName} onChange={(e) => set("middleName", e.target.value)} /></Field>
            <Field label="Last name"><input value={form.lastName} onChange={(e) => set("lastName", e.target.value)} /></Field>
            <Field label="Suffix (optional)"><input placeholder="Jr., III, …" value={form.suffix} onChange={(e) => set("suffix", e.target.value)} /></Field>
            <Field label="Email"><input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} /></Field>
            <Field label="Phone"><input value={form.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
            <Field label="Address"><input value={form.addressLine1} onChange={(e) => set("addressLine1", e.target.value)} /></Field>
            <Field label="City"><input value={form.city} onChange={(e) => set("city", e.target.value)} /></Field>
            <Field label="State / Region"><input value={form.stateRegion} onChange={(e) => set("stateRegion", e.target.value)} /></Field>
            <Field label="Postal code"><input value={form.postalCode} onChange={(e) => set("postalCode", e.target.value)} /></Field>
            <Field label="Country"><input value={form.country} onChange={(e) => set("country", e.target.value)} /></Field>
            <Field label="LinkedIn URL"><input value={form.linkedinUrl} onChange={(e) => set("linkedinUrl", e.target.value)} /></Field>
            <Field label="GitHub URL"><input value={form.githubUrl} onChange={(e) => set("githubUrl", e.target.value)} /></Field>
            <Field label="Portfolio URL"><input value={form.portfolioUrl} onChange={(e) => set("portfolioUrl", e.target.value)} /></Field>
          </div>

          <fieldset className="job-search-fieldset">
            <legend>Other links</legend>
            {form.otherLinks.map((link, index) => (
              <div key={index} className="job-search-repeater-row">
                <input placeholder="Label" value={link.label} onChange={(e) => updateListItem("otherLinks", index, { label: e.target.value })} />
                <input placeholder="URL" value={link.url} onChange={(e) => updateListItem("otherLinks", index, { url: e.target.value })} />
                <button type="button" onClick={() => removeListItem("otherLinks", index)}>Remove</button>
              </div>
            ))}
            <button type="button" onClick={() => addListItem("otherLinks", emptyLinkEntry)}>Add link</button>
          </fieldset>

          <fieldset className="job-search-fieldset">
            <legend>Work history (used for context + tech-stack matching)</legend>
            {form.workHistory.map((entry, index) => (
              <div key={index} className="job-search-repeater-block">
                <div className="job-search-repeater-row">
                  <input placeholder="Company" value={entry.company} onChange={(e) => updateListItem("workHistory", index, { company: e.target.value })} />
                  <input placeholder="Title" value={entry.title} onChange={(e) => updateListItem("workHistory", index, { title: e.target.value })} />
                  <input placeholder="Location" value={entry.location} onChange={(e) => updateListItem("workHistory", index, { location: e.target.value })} />
                </div>
                <div className="job-search-repeater-row">
                  <input placeholder="Start (YYYY-MM)" value={entry.startDate} onChange={(e) => updateListItem("workHistory", index, { startDate: e.target.value })} />
                  <input placeholder="End (YYYY-MM)" value={entry.endDate} disabled={entry.current} onChange={(e) => updateListItem("workHistory", index, { endDate: e.target.value })} />
                  <label className="job-search-checkbox">
                    <input type="checkbox" checked={entry.current} onChange={(e) => updateListItem("workHistory", index, { current: e.target.checked, endDate: e.target.checked ? "" : entry.endDate })} />
                    Current role
                  </label>
                </div>
                <textarea
                  placeholder="Description (skills, tech stack, achievements)"
                  value={entry.description}
                  onChange={(e) => updateListItem("workHistory", index, { description: e.target.value })}
                />
                <button type="button" onClick={() => removeListItem("workHistory", index)}>Remove entry</button>
              </div>
            ))}
            <button type="button" onClick={() => addListItem("workHistory", emptyWorkEntry)}>Add work history entry</button>
          </fieldset>

          <fieldset className="job-search-fieldset">
            <legend>Education</legend>
            {form.education.map((entry, index) => (
              <div key={index} className="job-search-repeater-row">
                <input placeholder="School" value={entry.school} onChange={(e) => updateListItem("education", index, { school: e.target.value })} />
                <input placeholder="Degree" value={entry.degree} onChange={(e) => updateListItem("education", index, { degree: e.target.value })} />
                <input placeholder="Field of study" value={entry.field} onChange={(e) => updateListItem("education", index, { field: e.target.value })} />
                <input placeholder="Start" value={entry.startDate} onChange={(e) => updateListItem("education", index, { startDate: e.target.value })} />
                <input placeholder="End" value={entry.endDate} onChange={(e) => updateListItem("education", index, { endDate: e.target.value })} />
                <button type="button" onClick={() => removeListItem("education", index)}>Remove</button>
              </div>
            ))}
            <button type="button" onClick={() => addListItem("education", emptyEducationEntry)}>Add education entry</button>
          </fieldset>

          <fieldset className="job-search-fieldset">
            <legend>Work authorization</legend>
            <p className="job-search-panel-hint">
              These fields are hard-mapped exactly as stored during autofill — never generated by the LLM.
            </p>
            <div className="job-search-field-grid">
              <Field label="Authorized to work in your target country?">
                <select
                  value={form.workAuthorization.authorizedInCountry}
                  onChange={(e) => setNested("workAuthorization", "authorizedInCountry", e.target.value)}
                >
                  <option value="">Select...</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </Field>
              <Field label="Will you require visa sponsorship?">
                <select
                  value={form.workAuthorization.requiresSponsorship}
                  onChange={(e) => setNested("workAuthorization", "requiresSponsorship", e.target.value)}
                >
                  <option value="">Select...</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </Field>
              <Field label="Country">
                <input
                  value={form.workAuthorization.country}
                  onChange={(e) => setNested("workAuthorization", "country", e.target.value)}
                />
              </Field>
            </div>
          </fieldset>

          <fieldset className="job-search-fieldset">
            <legend>Voluntary self-identification (EEO)</legend>
            <p className="job-search-panel-hint">
              Standard EEOC-style categories, matched against Greenhouse/Lever/Ashby forms during
              autofill. Also never LLM-touched. Leave any field blank to skip/decline on forms that allow it.
            </p>
            <div className="job-search-field-grid">
              <Field label="Gender">
                <select value={form.eeoAnswers.gender} onChange={(e) => setNested("eeoAnswers", "gender", e.target.value)}>
                  <option value="">Select...</option>
                  {GENDER_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </Field>
              <Field label="Race / Ethnicity">
                <select value={form.eeoAnswers.raceEthnicity} onChange={(e) => setNested("eeoAnswers", "raceEthnicity", e.target.value)}>
                  <option value="">Select...</option>
                  {RACE_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </Field>
              <Field label="Veteran status">
                <select value={form.eeoAnswers.veteranStatus} onChange={(e) => setNested("eeoAnswers", "veteranStatus", e.target.value)}>
                  <option value="">Select...</option>
                  {VETERAN_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </Field>
              <Field label="Disability status">
                <select value={form.eeoAnswers.disabilityStatus} onChange={(e) => setNested("eeoAnswers", "disabilityStatus", e.target.value)}>
                  <option value="">Select...</option>
                  {DISABILITY_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </Field>
            </div>
          </fieldset>

          <Field label="Cover letter template (optional, used as a starting point where a cover letter is requested)">
            <textarea
              rows={6}
              value={form.coverLetterTemplate}
              onChange={(e) => set("coverLetterTemplate", e.target.value)}
            />
          </Field>

          <div className="job-search-form-actions">
            <button type="submit" disabled={isBusy}>Save profile</button>
          </div>
        </form>
      </Panel>
    </>
  );
}
