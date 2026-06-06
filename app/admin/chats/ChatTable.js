"use client";

import { useState } from "react";

const muted = { color: "#64748b" };
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

const truncate = (text, max) =>
  text && text.length > max ? `${text.slice(0, max)}…` : (text || "-");

function ExpandableCell({ text, maxChars = 160 }) {
  const [expanded, setExpanded] = useState(false);
  const needsExpand = text && text.length > maxChars;

  return (
    <div>
      {expanded ? (
        <>
          <textarea
            readOnly
            value={text || ""}
            rows={6}
            style={{
              width: "100%",
              background: "rgba(0,0,0,0.3)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "8px",
              color: "#e2e8f0",
              fontSize: "13px",
              lineHeight: 1.6,
              padding: "10px",
              resize: "vertical",
              fontFamily: "inherit",
              boxSizing: "border-box"
            }}
            onClick={(e) => e.target.select()}
          />
          <button onClick={() => setExpanded(false)} style={collapseBtn}>
            Collapse
          </button>
        </>
      ) : (
        <div style={{ lineHeight: 1.5 }}>
          {truncate(text, maxChars)}
          {needsExpand && (
            <button onClick={() => setExpanded(true)} style={expandBtn}>
              View full
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function ChatTable({ logs }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.04)",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: "14px",
      boxShadow: "0 18px 50px rgba(0,0,0,0.18)",
      overflow: "hidden",
      marginBottom: "20px"
    }}>
      <div style={{ padding: "16px 18px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <p style={{
          color: "#cbd5e1",
          fontSize: "12px",
          fontWeight: "800",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          margin: 0
        }}>
          Detailed Records
        </p>
      </div>

      {logs.length === 0 ? (
        <p style={{ ...muted, fontSize: "14px", padding: "32px", margin: 0 }}>No conversations yet.</p>
      ) : (
        <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "620px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                {["Time", "User", "Question", "Response", "Model", "IP"].map((h) => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((log, i) => (
                <tr
                  key={log.id}
                  style={{
                    borderBottom: i < logs.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none",
                    background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.012)"
                  }}
                >
                  <td style={{ ...td, color: "#94a3b8", whiteSpace: "nowrap" }}>{fmtDate(log.createdAt)}</td>
                  <td style={{ ...td, color: "#bae6fd", whiteSpace: "nowrap", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {log.email || <span style={muted}>Anonymous</span>}
                  </td>
                  <td style={{ ...td, maxWidth: "220px" }}>
                    <ExpandableCell text={log.userMessage} maxChars={100} />
                  </td>
                  <td style={{ ...td, minWidth: "280px", maxWidth: "380px" }}>
                    <ExpandableCell text={log.aiResponse} maxChars={160} />
                  </td>
                  <td style={{ ...td, color: "#64748b", whiteSpace: "nowrap", fontFamily: "monospace", fontSize: "12px" }}>
                    {log.model || "-"}
                  </td>
                  <td style={{ ...td, fontFamily: "monospace", fontSize: "12px", color: "#64748b", whiteSpace: "nowrap" }}>
                    {log.ipAddress || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const expandBtn = {
  display: "inline-block",
  marginTop: "6px",
  padding: "3px 10px",
  background: "rgba(56,189,248,0.08)",
  border: "1px solid rgba(56,189,248,0.2)",
  borderRadius: "6px",
  color: "#7dd3fc",
  fontSize: "11px",
  fontWeight: "700",
  cursor: "pointer"
};

const collapseBtn = {
  display: "inline-block",
  marginTop: "6px",
  padding: "3px 10px",
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "6px",
  color: "#64748b",
  fontSize: "11px",
  fontWeight: "700",
  cursor: "pointer"
};
