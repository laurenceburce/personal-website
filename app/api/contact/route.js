import { NextResponse } from "next/server";
import { auth } from "../../../auth";
import { isAllowedOrigin } from "../utils/origin";

const contactRateLimit = new Map();
const CONTACT_LIMIT_MS = 10 * 60 * 1000;
const CONTACT_LIMIT_MAX = 5;
const CONTACT_EMAIL = "laurenceburce@gmail.com";
const RESEND_TIMEOUT_MS = 10000;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getContactErrorMessage(error) {
  if (error?.name === "AbortError") {
    return "Email request timed out. Please try again.";
  }

  return `Email delivery failed. Please email ${CONTACT_EMAIL} directly.`;
}

async function sendWithResend({ values, to }) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.RESEND_FROM || "Portfolio Contact <onboarding@resend.dev>").trim();

  if (!apiKey) {
    throw new Error("Missing RESEND_API_KEY.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: values.email,
        subject: `[Portfolio Contact] ${values.subject.replace(/[\r\n]/g, "")}`,
        text: `Name: ${values.name}\nEmail: ${values.email}\nSubject: ${values.subject}\n\n${values.message}`,
        html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0b1f45;">
            <h2 style="margin-bottom: 8px;">New Portfolio Contact Message</h2>
            <p><strong>Name:</strong> ${escapeHtml(values.name)}</p>
            <p><strong>Email:</strong> ${escapeHtml(values.email)}</p>
            <p><strong>Subject:</strong> ${escapeHtml(values.subject)}</p>
            <hr style="border:0;border-top:1px solid #d6e6ff;margin:16px 0;" />
            <p style="white-space: pre-wrap;">${escapeHtml(values.message)}</p>
          </div>
        `
      })
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload?.message || payload?.error || "Resend email delivery failed.");
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export const runtime = "nodejs";

const extractIp = (request) => {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();

  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();

  return "unknown";
};

function validatePayload(body) {
  const errors = [];
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim();
  const subject = String(body?.subject || "").trim();
  const message = String(body?.message || "").trim();
  const company = String(body?.company || "").trim();

  if (!name || name.length > 120) {
    errors.push("Invalid name.");
  }

  if (!email || !emailPattern.test(email) || email.length > 200) {
    errors.push("Invalid email address.");
  }

  if (!subject || subject.length < 3 || subject.length > 160) {
    errors.push("Invalid subject.");
  }

  if (!message || message.length > 5000) {
    errors.push("Invalid message body.");
  }

  return {
    errors,
    values: {
      name,
      email,
      subject,
      message,
      company
    }
  };
}

export async function POST(request) {
  try {
    if (!isAllowedOrigin(request)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const ip = extractIp(request);
    const now = Date.now();
    const entry = contactRateLimit.get(ip) ?? { count: 0, windowStart: now };
    if (now - entry.windowStart > CONTACT_LIMIT_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count++;
    contactRateLimit.set(ip, entry);
    if (entry.count > CONTACT_LIMIT_MAX) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
    }

    const body = await request.json();
    const { errors, values } = validatePayload(body);

    if (errors.length > 0) {
      return NextResponse.json({ error: errors[0] }, { status: 400 });
    }

    if (values.company) {
      return NextResponse.json({ ok: true });
    }

    const to = process.env.CONTACT_TO || CONTACT_EMAIL;

    if (!to) {
      return NextResponse.json(
        { error: "Contact form is currently unavailable." },
        { status: 500 }
      );
    }

    await sendWithResend({ values, to });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Contact form email failed", { message: error?.message });

    return NextResponse.json(
      { error: getContactErrorMessage(error) },
      { status: 500 }
    );
  }
}
