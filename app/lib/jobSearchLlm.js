import { GoogleGenAI } from "@google/genai";
import { JOB_SCORE_SCHEMA, SCORE_DIMENSIONS } from "./jobSearchScoringConfig.js";

// This is the one module every Gemini call goes through — the user's plan is
// to try a different (still-free) model down the line, so a provider swap
// should only ever touch this file.
const DEFAULT_SCORE_MODEL = "gemini-3.5-flash";
const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSIONS = 768;
const MAX_DESCRIPTION_CHARS = 6000;
const MAX_RESUME_CHARS = 4000;

function getApiKey() {
  return process.env.JOB_SEARCH_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";
}

export function isJobSearchLlmConfigured() {
  return Boolean(getApiKey());
}

function getClient() {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY (or JOB_SEARCH_GEMINI_API_KEY) is not configured.");
  return new GoogleGenAI({ apiKey });
}

export function getScoreModel() {
  return String(process.env.GEMINI_JOB_SCORE_MODEL || DEFAULT_SCORE_MODEL).trim() || DEFAULT_SCORE_MODEL;
}

export function getEmbeddingModel() {
  return String(process.env.GEMINI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL).trim() || DEFAULT_EMBEDDING_MODEL;
}

// taskType: "RETRIEVAL_QUERY" for the candidate profile, "RETRIEVAL_DOCUMENT" for
// postings — Gemini's embedding model documents asymmetric task types as best
// practice for this exact query-vs-corpus search/rank shape.
export async function embedText({ text, taskType }) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;

  const response = await getClient().models.embedContent({
    model: getEmbeddingModel(),
    contents: trimmed,
    config: { taskType, outputDimensionality: EMBEDDING_DIMENSIONS }
  });

  const values = response?.embeddings?.[0]?.values;
  if (!Array.isArray(values) || !values.length) {
    throw new Error("Gemini returned no embedding values.");
  }
  return values;
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildScoringPrompt({ posting, findSettings, resumeText }) {
  const dimensionGuide = SCORE_DIMENSIONS.map((d) => `- ${d.key} (${d.label}): ${d.promptHint}`).join("\n");
  const salaryLine = (posting.salaryMin || posting.salaryMax)
    ? `Disclosed salary: ${posting.salaryMin ?? "?"}-${posting.salaryMax ?? "?"} ${posting.salaryCurrency || ""}`
    : "Disclosed salary: not listed";

  return `You are scoring a job posting for how well it fits a specific candidate. Score each
dimension from 0 (worst) to 10 (best) based ONLY on the information given below. Do not invent
facts not present in the posting or candidate context.

DIMENSIONS TO SCORE:
${dimensionGuide}

CANDIDATE PREFERENCES:
- Target title keywords: ${(findSettings.titleKeywords || []).join(", ") || "(none specified)"}
- Preferred locations: ${(findSettings.locations || []).join(", ") || "(none specified)"}
- Remote preference: ${findSettings.remotePreference || "remote_friendly"}
- Target seniority levels: ${(findSettings.seniorityLevels || []).join(", ") || "(none specified)"}

CANDIDATE RESUME (may be partial/truncated):
${resumeText ? resumeText.slice(0, MAX_RESUME_CHARS) : "(no resume on file)"}

JOB POSTING:
Title: ${posting.title}
Company: ${posting.companyName}
Location: ${posting.locationText || "(not listed)"}
Remote type (heuristic guess): ${posting.remoteType}
Seniority (heuristic guess): ${posting.seniorityGuess}
${salaryLine}

Description:
${(posting.descriptionText || "").slice(0, MAX_DESCRIPTION_CHARS)}`;
}

// Fails loud (throws) on any error — jobSearchScoringPipeline.js decides how to
// recover (a posting just stays pending re-score rather than crashing the run).
export async function scoreJob({ posting, findSettings, resumeText }) {
  const model = getScoreModel();
  const response = await getClient().models.generateContent({
    model,
    contents: buildScoringPrompt({ posting, findSettings, resumeText }),
    config: {
      responseMimeType: "application/json",
      responseSchema: JOB_SCORE_SCHEMA,
      temperature: 0.2
    }
  });

  const text = response?.text;
  if (!text) throw new Error("Gemini returned an empty scoring response.");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned non-JSON scoring output.");
  }

  const dimensionScores = {};
  for (const dimension of SCORE_DIMENSIONS) {
    const raw = Number(parsed?.dimensions?.[dimension.key]);
    dimensionScores[dimension.key] = Number.isFinite(raw) ? Math.min(10, Math.max(0, raw)) : 0;
  }

  return {
    dimensionScores,
    reasoning: parsed?.reasoning && typeof parsed.reasoning === "object" ? parsed.reasoning : {},
    summary: String(parsed?.summary || "").slice(0, 1000),
    concerns: Array.isArray(parsed?.concerns) ? parsed.concerns.map((c) => String(c).slice(0, 300)).slice(0, 20) : [],
    model
  };
}

// Milestone 5: answers a novel free-text application question from resume/profile
// context only. Never used for EEO/work-authorization fields — those are always
// hard-mapped from stored profile data, never generated.
export async function answerFreeText({ question, posting, profile }) {
  const prompt = `You are helping a job applicant fill out a company's application form. Answer the
following question concisely and truthfully, using ONLY the candidate context given. If the
question cannot be answered from the given context, respond with exactly: UNKNOWN

QUESTION: ${String(question || "").slice(0, 500)}

CANDIDATE CONTEXT:
Name: ${profile?.fullName || ""}
Work history: ${JSON.stringify(profile?.workHistory || [])}
Education: ${JSON.stringify(profile?.education || [])}
Links: LinkedIn ${profile?.linkedinUrl || "(none)"}, GitHub ${profile?.githubUrl || "(none)"}, Portfolio ${profile?.portfolioUrl || "(none)"}

JOB CONTEXT:
Title: ${posting?.title || ""} at ${posting?.companyName || ""}

Answer in plain text, 1-3 sentences, no markdown.`;

  const response = await getClient().models.generateContent({
    model: getScoreModel(),
    contents: prompt,
    config: { temperature: 0.3 }
  });

  const text = String(response?.text || "").trim();
  if (!text || text === "UNKNOWN") return null;
  return text.slice(0, 1000);
}
