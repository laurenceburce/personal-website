import { analyticsTrackingDisabled, getOrCreateVisitorId, trackAnalyticsEvent } from "../../utils/analyticsClient";

export const downloadLinks = [
  {
    label: "Resume",
    ariaLabel: "Download Resume",
    href: "/Laurence-Alec-Burce-Software-Developer-Resume.pdf",
    tone: "resume"
  },
  {
    label: "Cover Letter",
    ariaLabel: "Download Cover Letter",
    href: "/Laurence-Alec-Burce-Cover-Letter.pdf",
    tone: "letter"
  }
];

export const trackDownload = (label) => {
  if (analyticsTrackingDisabled()) return;
  const visitorId = getOrCreateVisitorId();
  if (visitorId) trackAnalyticsEvent("download", label);
};
