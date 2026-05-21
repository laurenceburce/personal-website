import { NextResponse } from "next/server";
import nodemailer from "nodemailer";

export const runtime = "nodejs";

function validatePayload(body) {
  const errors = [];
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim();
  const subject = String(body?.subject || "").trim();
  const message = String(body?.message || "").trim();
  const company = String(body?.company || "").trim();

  if (!name || name.length < 2 || name.length > 120) {
    errors.push("Invalid name.");
  }

  if (!email || !emailPattern.test(email) || email.length > 200) {
    errors.push("Invalid email address.");
  }

  if (!subject || subject.length < 3 || subject.length > 160) {
    errors.push("Invalid subject.");
  }

  if (!message || message.length < 20 || message.length > 5000) {
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
        { error: "Email service is not configured yet. Please set SMTP environment variables." },
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
      subject: `[Portfolio Contact] ${values.subject}`,
      text: `Name: ${values.name}\nEmail: ${values.email}\nSubject: ${values.subject}\n\n${values.message}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0b1f45;">
          <h2 style="margin-bottom: 8px;">New Portfolio Contact Message</h2>
          <p><strong>Name:</strong> ${values.name}</p>
          <p><strong>Email:</strong> ${values.email}</p>
          <p><strong>Subject:</strong> ${values.subject}</p>
          <hr style="border:0;border-top:1px solid #d6e6ff;margin:16px 0;" />
          <p style="white-space: pre-wrap;">${values.message}</p>
        </div>
      `
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Something went wrong while sending your message." },
      { status: 500 }
    );
  }
}
