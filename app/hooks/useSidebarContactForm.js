"use client";

import { useState } from "react";
import { getSession } from "next-auth/react";
import { getOrCreateVisitorId, identifyAnalyticsVisitor } from "../utils/analyticsClient";
import { sidebarContactInitial, validateSidebarContact } from "../utils/sidebarContact";

const CONTACT_REQUEST_TIMEOUT_MS = 15000;

export default function useSidebarContactForm() {
  const [form, setForm] = useState(sidebarContactInitial);
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState({ type: "idle", message: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleChange = (event) => {
    const { name, value } = event.target;

    setForm((prev) => ({
      ...prev,
      [name]: value
    }));

    setErrors((prev) => {
      if (!prev[name]) return prev;

      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    let timeoutId;

    const nextErrors = validateSidebarContact(form);

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setStatus({ type: "error", message: "Please fix the form fields." });
      return;
    }

    try {
      setIsSubmitting(true);
      setStatus({ type: "idle", message: "" });

      const controller = new AbortController();
      timeoutId = window.setTimeout(() => {
        controller.abort();
      }, CONTACT_REQUEST_TIMEOUT_MS);

      const response = await fetch("/api/contact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        signal: controller.signal,
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          subject: "Portfolio Sidebar Contact",
          message: form.message,
          company: form.company,
          visitorId: getOrCreateVisitorId()
        })
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Unable to send message right now.");
      }

      const session = await getSession().catch(() => null);

      identifyAnalyticsVisitor({
        email: form.email,
        name: form.name,
        authProvider: session?.user?.provider || "",
        profileImage: session?.user?.image || ""
      }).catch(() => {});

      setStatus({
        type: "success",
        message: "Message sent."
      });
      setForm(sidebarContactInitial);
      setErrors({});
    } catch (error) {
      setStatus({
        type: "error",
        message: error.name === "AbortError"
          ? "Sending timed out. Please try again."
          : error.message || "Unable to send message right now."
      });
    } finally {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
      setIsSubmitting(false);
    }
  };

  return {
    form,
    errors,
    status,
    isSubmitting,
    handleChange,
    handleSubmit
  };
}
