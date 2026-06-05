import { NextResponse } from "next/server";
import nodemailer from "nodemailer";

const contactRateLimit = new Map();
const CONTACT_LIMIT_MS = 60 * 60 * 1000;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const runtime = "nodejs";

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
    const allowedOrigin = process.env.NEXT_PUBLIC_SITE_URL || "";
    const origin = request.headers.get("origin") || "";
    if (allowedOrigin && origin && origin !== allowedOrigin) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const lastSent = contactRateLimit.get(ip) ?? 0;
    if (Date.now() - lastSent < CONTACT_LIMIT_MS) {
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

    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const to = process.env.CONTACT_TO || user;
    const from = process.env.CONTACT_FROM || user;
    const secure = process.env.SMTP_SECURE === "true" || port === 465;

    if (!host || !user || !pass || !to || !from) {
      return NextResponse.json(
        { error: "Contact form is currently unavailable." },
        { status: 500 }
      );
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass
      }
    });

    await transporter.sendMail({
      from,
      to,
      replyTo: values.email,
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
    });

    contactRateLimit.set(ip, Date.now());

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Something went wrong while sending your message." },
      { status: 500 }
    );
  }
}
