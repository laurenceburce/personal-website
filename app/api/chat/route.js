import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { auth } from "../../../auth";
import { PORTFOLIO_CONTEXT } from "../../lib/portfolioContext";

export const runtime = "nodejs";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

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

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: PORTFOLIO_CONTEXT
    });

    const geminiHistory = history
      .filter(m => m?.content?.trim())
      .slice(-10)
      .map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: String(m.content).slice(0, 2000) }]
      }));

    const chat = model.startChat({ history: geminiHistory });
    const result = await chat.sendMessageStream(message);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of result.stream) {
            const text = chunk.text();
            if (text) controller.enqueue(encoder.encode(text));
          }
        } catch {
          controller.enqueue(encoder.encode("I encountered an issue. Please try again."));
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  } catch {
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
