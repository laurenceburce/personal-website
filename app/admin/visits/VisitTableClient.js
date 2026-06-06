"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";

const muted = { color: "#64748b" };

const deviceColors = { desktop: "#94a3b8", mobile: "#cbd5e1", tablet: "#64748b" };

const badge = (text, color) => (
  <span style={{
    display: "inline-block",
    padding: "3px 8px",
    borderRadius: "999px",
    fontSize: "11px",
    fontWeight: "800",
    background: "rgba(148,163,184,0.1)",
    border: "1px solid rgba(148,163,184,0.16)",
    color: color ?? "#94a3b8",
    whiteSpace: "nowrap"
  }}>
    {text}
  </span>
);

const fmtDate = (iso) => {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short"
  });
};

const fmtTime = (seconds) => {
  if (seconds == null) return null;
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
};

const fmtOffset = (visitedAt, clickTs) => {
  const diff = Math.max(0, Math.round((new Date(clickTs) - new Date(visitedAt)) / 1000));
  if (diff < 60) return `+${diff}s`;
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return s > 0 ? `+${m}m ${s}s` : `+${m}m`;
};

const formatVisitor = (visit) => {
  if (visit.email) return visit.name ? `${visit.name} <${visit.email}>` : visit.email;
  return `Anonymous ${visit.visitorId.slice(0, 8)}`;
};

const formatAuthProvider = (provider) => {
  const labels = { google: "Google", github: "GitHub", linkedin: "LinkedIn", "microsoft-entra-id": "Microsoft" };
  return labels[provider] || provider || "-";
};

const formatLocation = (visit) => {
  if (visit.city && visit.country) return `${visit.city}, ${visit.country}`;
  return visit.country || "Unknown location";
};

const formatReferrer = (visit) => {
  if (visit.referredByIpAddress) return `Shared from ${visit.referredByIpAddress}`;
  return visit.referrer || "Direct";
};

const shareLabel = (visit) => {
  if (visit.referredByShareId) return `Opened share ${visit.referredByShareId}`;
  if (visit.createdShareId) return `Created share ${visit.createdShareId}`;
  return "-";
};

const th = {
  textAlign: "left",
  padding: "12px 14px",
  color: "#64748b",
  fontWeight: "800",
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  whiteSpace: "nowrap"
};

const td = {
  padding: "12px 14px",
  color: "#cbd5e1",
  verticalAlign: "top"
};

function ExpandedClicks({ visit }) {
  const { clicks, visitedAt } = visit;

  if (!clicks || clicks.length === 0) {
    return (
      <div style={{ padding: "14px 20px", color: "#475569", fontSize: "12px", fontStyle: "italic" }}>
        No click events recorded for this session.
      </div>
    );
  }

  return (
    <div style={{ padding: "14px 20px 18px" }}>
      <p style={{
        fontSize: "10px",
        fontWeight: "800",
        color: "#475569",
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        margin: "0 0 10px"
      }}>
        Click Timeline — {clicks.length} event{clicks.length !== 1 ? "s" : ""}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
        {clicks.map((click, i) => (
          <div
            key={click.id}
            style={{
              display: "grid",
              gridTemplateColumns: "52px 1fr auto",
              alignItems: "baseline",
              gap: "12px",
              padding: "5px 0",
              borderTop: i > 0 ? "1px solid rgba(255,255,255,0.04)" : "none"
            }}
          >
            <span style={{
              fontFamily: "monospace",
              fontSize: "10px",
              color: "#475569",
              flexShrink: 0,
              paddingTop: "1px"
            }}>
              {fmtOffset(visitedAt, click.timestamp)}
            </span>
            <span style={{ color: "#bae6fd", fontSize: "12px", fontWeight: "600" }}>
              {click.eventName}
            </span>
            {click.metadata ? (
              <span style={{
                color: "#475569",
                fontSize: "10px",
                fontFamily: "monospace",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: "260px",
                textAlign: "right"
              }}>
                {click.metadata.length > 60 ? click.metadata.slice(0, 57) + "…" : click.metadata}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function VisitRow({ visit, index, isLast }) {
  const [expanded, setExpanded] = useState(false);
  const hasClicks = visit.clicks && visit.clicks.length > 0;

  return (
    <>
      <tr
        onClick={() => hasClicks && setExpanded((e) => !e)}
        style={{
          borderBottom: !expanded && !isLast ? "1px solid rgba(255,255,255,0.05)" : "none",
          background: index % 2 === 0 ? "transparent" : "rgba(255,255,255,0.012)",
          cursor: hasClicks ? "pointer" : "default",
          transition: "background 0.12s"
        }}
      >
        <td style={{ ...td, color: "#94a3b8", whiteSpace: "nowrap" }}>{fmtDate(visit.visitedAt)}</td>
        <td style={td}>
          <div style={{ color: visit.email ? "#bae6fd" : "#cbd5e1", maxWidth: "210px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {formatVisitor(visit)}
          </div>
          {!visit.email ? (
            <div style={{ ...muted, fontFamily: "monospace", fontSize: "11px", marginTop: "2px" }}>
              {visit.visitorId.slice(0, 12)}
            </div>
          ) : null}
        </td>
        <td style={{ ...td, color: "#94a3b8", whiteSpace: "nowrap" }}>{formatAuthProvider(visit.authProvider)}</td>
        <td style={{ ...td, whiteSpace: "nowrap" }}>{formatLocation(visit)}</td>
        <td style={{ ...td, maxWidth: "190px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#cbd5e1" }}>
          {formatReferrer(visit)}
        </td>
        <td style={{ ...td, color: visit.referredByShareId ? "#cbd5e1" : "#94a3b8", whiteSpace: "nowrap" }}>
          {shareLabel(visit)}
        </td>
        <td style={td}>
          {visit.deviceType ? badge(visit.deviceType, deviceColors[visit.deviceType]) : <span style={muted}>-</span>}
        </td>
        <td style={td}>{visit.browser || <span style={muted}>-</span>}</td>
        <td style={{ ...td, color: "#94a3b8", whiteSpace: "nowrap" }}>
          {fmtTime(visit.timeOnPage) || <span style={muted}>-</span>}
        </td>
        <td style={{ ...td, fontFamily: "monospace", fontSize: "12px", color: "#64748b", whiteSpace: "nowrap" }}>
          {visit.ipAddress || "-"}
        </td>
        <td style={{ ...td, textAlign: "center", width: "36px", color: "#475569", fontSize: "11px", userSelect: "none" }}>
          {hasClicks ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              <span style={{ color: "#64748b", fontSize: "10px" }}>{visit.clicks.length}</span>
              <span style={{
                transition: "transform 0.2s",
                display: "inline-block",
                transform: expanded ? "rotate(180deg)" : "rotate(0deg)"
              }}>▾</span>
            </span>
          ) : null}
        </td>
      </tr>

      <AnimatePresence initial={false}>
        {expanded && (
          <tr key={`expand-${visit.id}`} style={{ borderBottom: !isLast ? "1px solid rgba(255,255,255,0.05)" : "none" }}>
            <td colSpan={11} style={{ padding: 0 }}>
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: "easeInOut" }}
                style={{ overflow: "hidden", background: "rgba(0,0,0,0.25)", borderTop: "1px solid rgba(148,163,184,0.08)" }}
              >
                <ExpandedClicks visit={visit} />
              </motion.div>
            </td>
          </tr>
        )}
      </AnimatePresence>
    </>
  );
}

export default function VisitTableClient({ visits }) {
  if (visits.length === 0) {
    return (
      <p style={{ color: "#64748b", fontSize: "14px", padding: "32px", margin: 0 }}>
        No visits recorded yet.
      </p>
    );
  }

  return (
    <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "620px" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            {["Time", "Visitor", "Auth", "Location", "Source", "Share", "Device", "Browser", "Duration", "IP", ""].map((h, i) => (
              <th key={i} style={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visits.map((visit, i) => (
            <VisitRow
              key={visit.id}
              visit={visit}
              index={i}
              isLast={i === visits.length - 1}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
