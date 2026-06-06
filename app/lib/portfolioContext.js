import { readFileSync } from "fs";
import { join } from "path";

const systemRules = readFileSync(
  join(process.cwd(), "public", "logos", "chatbot_system_rules.md"),
  "utf-8"
);

const knowledgeBase = readFileSync(
  join(process.cwd(), "public", "logos", "public_knowledge_base.md"),
  "utf-8"
);

export const PORTFOLIO_CONTEXT = `${systemRules}\n\n---\n\n${knowledgeBase}`;
