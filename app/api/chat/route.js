import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import { auth } from "../../../auth";
import { PORTFOLIO_CONTEXT } from "../../lib/portfolioContext";
import { logChatMessage } from "../../lib/analyticsStore";

export const runtime = "nodejs";

const DEFAULT_MODEL = "gemini-2.5-flash";

const rateLimitStore = new Map();
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS = 40;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    rateLimitStore.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= MAX_REQUESTS) return false;

  entry.count++;
  return true;
}

function getGeminiClient() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function getGeminiModel() {
  return String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function logChatError(message, error, details = {}) {
  console.error("AI chat failed", {
    message,
    name: error?.name,
    status: error?.status,
    details
  });
}

export async function POST(request) {
  try {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ error: "AI assistant is not configured." }, { status: 503 });
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    if (!checkRateLimit(ip)) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
    }

    const body = await request.json();
    const message = String(body?.message || "").trim();
    const history = Array.isArray(body?.history) ? body.history : [];

    if (!message || message.length > 1000) {
      return NextResponse.json({ error: "Invalid message." }, { status: 400 });
    }

    const geminiHistory = history
      .filter(m => m?.content?.trim())
      .slice(-10)
      .map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: String(m.content).slice(0, 2000) }]
      }));

    const model = getGeminiModel();
    const chat = getGeminiClient().chats.create({
      model,
      history: geminiHistory,
      config: {
        systemInstruction: PORTFOLIO_CONTEXT
      }
    });
    const result = await chat.sendMessageStream({ message });

    const email = session.user.email;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let fullResponse = "";
        try {
          for await (const chunk of result) {
            const text = chunk.text;
            if (text) {
              fullResponse += text;
              controller.enqueue(encoder.encode(text));
            }
          }
        } catch (error) {
          logChatError("Gemini stream error", error, { model });
          const msg = (error?.status === 429 || error?.message?.includes("quota"))
            ? "The AI assistant is temporarily unavailable due to high demand. Please try again later."
            : "I encountered an issue. Please try again.";
          fullResponse = msg;
          controller.enqueue(encoder.encode(msg));
        } finally {
          controller.close();
          logChatMessage({ email, userMessage: message, aiResponse: fullResponse, model, ipAddress: ip }).catch(() => {});
        }
      }
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  } catch (error) {
    logChatError("Chat request error", error);
    if (error?.status === 429 || error?.message?.includes("429") || error?.message?.includes("quota")) {
      return NextResponse.json({ error: "The AI assistant is temporarily unavailable due to high demand. Please try again later." }, { status: 503 });
    }
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
