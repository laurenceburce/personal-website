import { NextResponse } from "next/server";
import dns from "dns";
import nodemailer from "nodemailer";

const contactRateLimit = new Map();
const CONTACT_LIMIT_MS = 60 * 60 * 1000;
const SMTP_TIMEOUT_MS = 10000;
const CONTACT_EMAIL = "laurenceburce@gmail.com";
const smtpAddressCache = new Map();

function parseBoolean(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

async function resolveSmtpHost(host) {
  const normalizedHost = host.trim().toLowerCase();
  const cached = smtpAddressCache.get(normalizedHost);

  if (cached) return cached;

  try {
    const addresses = await dns.promises.resolve4(normalizedHost);
    const resolved = {
      connectHost: addresses[0] || normalizedHost,
      servername: normalizedHost
    };
    smtpAddressCache.set(normalizedHost, resolved);
    return resolved;
  } catch {
    const resolved = {
      connectHost: normalizedHost,
      servername: normalizedHost
    };
    smtpAddressCache.set(normalizedHost, resolved);
    return resolved;
  }
}

async function createMailTransport({ host, port, secure, user, pass }) {
  const normalizedHost = host.trim().toLowerCase();
  const { connectHost, servername } = await resolveSmtpHost(normalizedHost);

  return nodemailer.createTransport({
    host: connectHost,
    port,
    secure,
    requireTLS: !secure,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    tls: {
      servername
    },
    auth: {
      user,
      pass
    }
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getContactErrorMessage(error) {
  const code = error?.code || "";
  const command = error?.command || "";

  if (code === "EAUTH") {
    return "Email authentication failed. Please check the SMTP username and app password.";
  }

  if (code === "EENVELOPE" || command === "MAIL FROM" || command === "RCPT TO") {
    return "Email sender or recipient was rejected. Please check CONTACT_FROM and CONTACT_TO.";
  }

  if (code === "ETIMEDOUT" || code === "ESOCKET" || code === "ECONNECTION") {
    return "Email server connection failed. Check SMTP_HOST, SMTP_PORT, and SMTP_SECURE. For Gmail use smtp.gmail.com with port 465 and SMTP_SECURE=true, or port 587 and SMTP_SECURE=false.";
  }

  return `Email delivery failed. Please email ${CONTACT_EMAIL} directly.`;
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

    const host = String(process.env.SMTP_HOST || "").trim();
    const port = Number(process.env.SMTP_PORT || 587);
    const user = String(process.env.SMTP_USER || "").trim();
    const pass = String(process.env.SMTP_PASS || "").trim();
    const to = process.env.CONTACT_TO || CONTACT_EMAIL;
    const from = process.env.CONTACT_FROM || `"Portfolio Contact" <${user}>`;
    const secure = parseBoolean(process.env.SMTP_SECURE) || port === 465;

    if (!host || !user || !pass || !to || !from) {
      return NextResponse.json(
        { error: "Contact form is currently unavailable." },
        { status: 500 }
      );
    }

    const transporter = await createMailTransport({
      host,
      port,
      secure,
      user,
      pass
    });

    await transporter.sendMail({
      from,
      to,
      envelope: {
        from: user,
        to
      },
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
  } catch (error) {
    console.error("Contact form email failed", {
      code: error?.code,
      command: error?.command,
      message: error?.message
    });

    return NextResponse.json(
      { error: getContactErrorMessage(error) },
      { status: 500 }
    );
  }
}
