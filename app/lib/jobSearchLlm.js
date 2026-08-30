import { GoogleGenAI } from "@google/genai";
import { JOB_SCORE_SCHEMA, SCORE_DIMENSIONS } from "./jobSearchScoringConfig.js";

// This is the one module every Gemini call goes through — the user's plan is
// to try a different (still-free) model down the line, so a provider swap
// should only ever touch this file.
// 3.6 over 3.5: same base architecture (no regression risk), cheaper through
// end of 2026 ($0.75/$3.75 per 1M vs 3.5's $1.50/$9.00). 3.6 over 3.7: 3.7's
// gains concentrate in coding/multi-step-agent benchmarks (not this task), and
// it has a higher hallucination rate than 3.6 at launch — undesirable for a
// task that needs grounded, non-invented judgments about a job posting.
const DEFAULT_SCORE_MODEL = "gemini-3.6-flash";
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

// Constructed once and reused — building a fresh client per call (the
// previous behavior) doesn't do any network I/O itself, but there's no
// reason to repeat even that small overhead on every single embed/score call
// in a scoring run that can make several of these back to back.
let cachedClient = null;
function getClient() {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY (or JOB_SEARCH_GEMINI_API_KEY) is not configured.");
  if (!cachedClient) cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
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
//
// resumeText is the resume's own parsed text (job_search_resumes.parsed_text) —
// optional (a caller might not have it in scope), but genuinely improves
// answer quality when it does: the structured work-history JSON below only
// has company/title/dates/bullet-description, never a dedicated skills list,
// so a question like "years of experience with X" had nothing to check X
// against beyond hoping X was mentioned in a bullet point.
//
// Confirmed live (audit pass) as a real, fixable over-conservatism: the
// model was defaulting to UNKNOWN on ANY question requiring it to calculate
// something (e.g. "how many years of experience do you have") even though
// the raw start/end dates needed for that calculation were right there in
// Work history — it would rather decline than do the arithmetic itself.
// Telling it today's date and explicitly permitting/expecting it to compute
// durations itself resolved this in testing, without making it any less
// honest about questions the profile genuinely can't fully answer — it just
// leads with whatever relevant experience DOES exist instead of leading with
// the gap. (Deliberately not "admit what's missing, then pivot" — an early
// version did that, e.g. "I don't have .NET experience, but I have 3 years
// of Java/Python backend work", and got explicitly walked back: a real
// candidate answering this well wouldn't volunteer the gap either, they'd
// just talk about the closest relevant experience they have. Still never
// invents experience that isn't in the context below — this changes framing,
// not the facts.)
export async function answerFreeText({ question, posting, profile, resumeText }) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `You are helping a job applicant fill out a company's application form. Answer the
following question concisely and truthfully, using ONLY the candidate context given.
Today's date is ${today} — if the question asks about years/duration of experience, CALCULATE
it yourself from the start/end dates given below rather than declining to answer; only respond
UNKNOWN if the context is missing entirely (never just because a calculation is required). If the
question asks about a specific skill or technology you have no direct evidence of, do NOT claim
it, but also do NOT explicitly call out that it's missing — instead answer with the closest
relevant/adjacent experience you do have, framed as a strength, the way a strong candidate would
naturally pivot in an interview. Never invent experience that isn't in the context below; only
fall back to UNKNOWN when nothing in the context is relevant to the question at all.

QUESTION: ${String(question || "").slice(0, 500)}

CANDIDATE CONTEXT:
Name: ${profile?.fullName || ""}
Work history: ${JSON.stringify(profile?.workHistory || [])}
Education: ${JSON.stringify(profile?.education || [])}
Links: LinkedIn ${profile?.linkedinUrl || "(none)"}, GitHub ${profile?.githubUrl || "(none)"}, Portfolio ${profile?.portfolioUrl || "(none)"}
${resumeText ? `Resume text (for skills/technologies/summary detail not captured above):\n${String(resumeText).slice(0, 6000)}\n` : ""}
JOB CONTEXT:
Title: ${posting?.title || ""} at ${posting?.companyName || ""}

Answer in plain text, 1-3 sentences, no markdown. Respond with exactly UNKNOWN only if truly
nothing in the context above is relevant to the question.`;

  const response = await getClient().models.generateContent({
    model: getScoreModel(),
    contents: prompt,
    config: { temperature: 0.3 }
  });

  const text = String(response?.text || "").trim();
  if (!text || text === "UNKNOWN") return null;
  return text.slice(0, 1000);
}

// For a fixed-choice question (radio/select — no free text allowed) where the
// candidate's own resume genuinely determines the right answer: "years of
// experience with X" rendered as a multiple-choice range ("0-1", "1-3", ...)
// rather than a text box is the confirmed-live motivating case (a real
// Codurance/Workable posting; see workable.js's own comment on this).
//
// Deliberately narrow — this is NOT a general "guess any radio group"
// escape hatch. A question about the candidate's actual skills/experience is
// something their resume can genuinely answer; a question about their
// PREFERENCES or LOGISTICS (salary expectations, notice period, willingness
// to work on-site N days/week) is not something any resume states, and
// answering one of those on the candidate's behalf means committing them to
// something they never actually agreed to — that risk is real regardless of
// how much the caller wants to avoid manual review, so callers should only
// route a question here when it's independently classified as an
// experience/skill-duration question (see workable.js's
// looksLikeExperienceDurationQuestion()), never for arbitrary radio groups.
export async function chooseFromOptions({ question, options, posting, profile, resumeText }) {
  const cleanOptions = (options || []).map((o) => String(o || "").trim()).filter(Boolean);
  if (cleanOptions.length === 0) return null;
  const today = new Date().toISOString().slice(0, 10);
  const optionList = cleanOptions.map((o, i) => `${i + 1}. ${o}`).join("\n");

  const prompt = `You are helping a job applicant answer a multiple-choice question on a company's
application form — this question ONLY accepts one of the exact options listed below, no free text.
Pick the ONE option that best matches the candidate, using ONLY the candidate context given.
Today's date is ${today} — if the options represent experience durations, calculate the
candidate's real duration yourself from the work history's start/end dates rather than declining.
Respond with ONLY the exact text of your chosen option, copied verbatim from the numbered list,
and nothing else — no numbering, no punctuation, no explanation. If truly none of the options
reasonably apply, respond with exactly: UNKNOWN

QUESTION: ${String(question || "").slice(0, 500)}

OPTIONS:
${optionList}

CANDIDATE CONTEXT:
Name: ${profile?.fullName || ""}
Work history: ${JSON.stringify(profile?.workHistory || [])}
Education: ${JSON.stringify(profile?.education || [])}
${resumeText ? `Resume text (for skills/technologies/summary detail not captured above):\n${String(resumeText).slice(0, 6000)}\n` : ""}
JOB CONTEXT:
Title: ${posting?.title || ""} at ${posting?.companyName || ""}`;

  const response = await getClient().models.generateContent({
    model: getScoreModel(),
    contents: prompt,
    config: { temperature: 0.1 }
  });

  const text = String(response?.text || "").trim();
  if (!text || text === "UNKNOWN") return null;
  // Only trust an EXACT match against a real option — never a close/fuzzy
  // guess for a question with real, fixed choices; a paraphrased or
  // hallucinated response that doesn't match anything verbatim is treated
  // exactly like UNKNOWN.
  return cleanOptions.find((o) => o.toLowerCase() === text.toLowerCase()) || null;
}
