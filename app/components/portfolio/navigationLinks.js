import { analyticsTrackingDisabled, getOrCreateVisitorId, trackAnalyticsEvent } from "../../utils/analyticsClient";

export const downloadLinks = [
  {
    label: "Resume",
    ariaLabel: "Download Resume",
    href: "/api/download/resume",
    tone: "resume"
  },
  {
    label: "Cover Letter",
    ariaLabel: "Download Cover Letter",
    href: "/api/download/cover-letter",
    tone: "letter"
  }
];

export const trackDownload = (label, href = "") => {
  if (analyticsTrackingDisabled()) return;
  const visitorId = getOrCreateVisitorId();
  if (visitorId) trackAnalyticsEvent(`Download: ${label}`, href);
};
