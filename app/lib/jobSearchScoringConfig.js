import { Type } from "@google/genai";

// Fixed rubric dimensions the LLM scores 0-10, higher always meaning "more
// favorable" so the weighted average stays a simple sum. promptHint tells the
// model what 0/10 mean for that dimension; it never sees the weight itself.
export const SCORE_DIMENSIONS = [
  {
    key: "titleRoleFit",
    label: "Title / Role Fit",
    promptHint: "How well the job title and responsibilities match the candidate's target roles and keywords. 10 = near-exact match, 0 = unrelated role."
  },
  {
    key: "seniorityFit",
    label: "Seniority Fit",
    promptHint: "How well the seniority level matches the candidate's experience. 10 = ideal level, 0 = wildly over- or under-qualified."
  },
  {
    key: "locationRemoteFit",
    label: "Location / Remote Fit",
    promptHint: "How well the location or remote arrangement matches the candidate's stated preference. 10 = perfect fit, 0 = incompatible location requirement."
  },
  {
    key: "techStackFit",
    label: "Tech Stack Fit",
    promptHint: "How well the required skills/technologies match the candidate's resume. 10 = strong overlap, 0 = no overlap."
  },
  {
    key: "compensationFit",
    label: "Compensation Fit",
    promptHint: "How competitive the disclosed compensation looks for the role/seniority/location. 10 = strong comp, 5 = undisclosed/unknown, 0 = clearly below market."
  },
  {
    key: "growthOpportunity",
    label: "Growth Opportunity",
    promptHint: "How much the role appears to offer learning, scope, or career growth based on the description. 10 = strong growth signal, 0 = none evident."
  },
  {
    key: "cultureFit",
    label: "Culture Fit / No Red Flags",
    promptHint: "How free the listing is of concerning language (excessive urgency, vague responsibilities, boilerplate red flags). 10 = no concerns, 0 = severe red flags."
  }
];

// Weights live here, in code — never sent to the model. The model only ever
// returns raw per-dimension scores; jobSearchScoringPipeline.js computes the
// weighted overall from these.
export const SCORE_WEIGHTS = {
  titleRoleFit: 0.25,
  seniorityFit: 0.15,
  locationRemoteFit: 0.15,
  techStackFit: 0.20,
  compensationFit: 0.10,
  growthOpportunity: 0.05,
  cultureFit: 0.10
};

export const JOB_SCORE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    dimensions: {
      type: Type.OBJECT,
      properties: Object.fromEntries(
        SCORE_DIMENSIONS.map((d) => [d.key, { type: Type.INTEGER, description: d.promptHint }])
      ),
      required: SCORE_DIMENSIONS.map((d) => d.key)
    },
    reasoning: {
      type: Type.OBJECT,
      properties: Object.fromEntries(
        SCORE_DIMENSIONS.map((d) => [d.key, { type: Type.STRING, description: "One short sentence justifying the score." }])
      ),
      required: SCORE_DIMENSIONS.map((d) => d.key)
    },
    summary: { type: Type.STRING, description: "1-2 sentence overall summary of the fit." },
    concerns: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Notable concerns or red flags found in the listing, if any. Empty array if none."
    }
  },
  required: ["dimensions", "reasoning", "summary", "concerns"]
};

// Rough annual USD bands per seniority guess, used only by the scam-risk
// heuristic (Milestone 3) to flag comp that's a wild outlier — not used for
// hard filtering, since these are deliberately generous/approximate.
export const SALARY_BANDS = {
  intern: { min: 20000, max: 80000 },
  junior: { min: 40000, max: 90000 },
  mid: { min: 70000, max: 140000 },
  senior: { min: 110000, max: 220000 },
  staff: { min: 140000, max: 260000 },
  lead: { min: 120000, max: 230000 },
  principal: { min: 160000, max: 300000 },
  director: { min: 150000, max: 320000 },
  unknown: { min: 40000, max: 260000 }
};
