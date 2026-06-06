import Link from "next/link";
import { getVisitsList } from "../../lib/analyticsStore";

export const dynamic = "force-dynamic";

const pageStyle = {
  minHeight: "100vh",
  background: "linear-gradient(135deg, #080c1c 0%, #040810 100%)",
  fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  color: "#f8fafc",
  padding: "32px 24px"
};
const shell = { maxWidth: "1220px", margin: "0 auto" };
const card = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: "14px",
  boxShadow: "0 18px 50px rgba(0,0,0,0.18)"
};
const muted = { color: "#64748b" };
const sectionTitle = {
  color: "#cbd5e1",
  fontSize: "12px",
  fontWeight: "800",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  margin: 0
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

const fmtTime = (seconds) => {
  if (seconds == null) return null;
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
};

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

const formatVisitor = (visit) => {
  if (visit.email) return visit.name ? `${visit.name} <${visit.email}>` : visit.email;
  return `Anonymous ${visit.visitorId.slice(0, 8)}`;
};

const formatAuthProvider = (provider) => {
  const labels = {
    google: "Google",
    github: "GitHub",
    linkedin: "LinkedIn",
    "microsoft-entra-id": "Microsoft"
  };

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

function Header({ total }) {
  return (
    <div className="admin-header" style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
      gap: "18px",
      marginBottom: "28px"
    }}>
      <div>
        <Link href="/admin" style={{ color: "#64748b", fontSize: "13px", fontWeight: "700", textDecoration: "none" }}>
          Back to dashboard
        </Link>
        <h1 style={{ fontSize: "28px", lineHeight: 1.1, fontWeight: "850", margin: "12px 0 8px" }}>
          Visit Log
        </h1>
        <p style={{ ...muted, fontSize: "14px", margin: 0 }}>
          {total.toLocaleString()} recorded visits, newest first.
        </p>
      </div>
    </div>
  );
}


function VisitTable({ visits }) {
  return (
    <div style={{ ...card, overflow: "hidden", marginBottom: "20px" }}>
      <div style={{ padding: "16px 18px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <p style={sectionTitle}>Detailed Records</p>
      </div>
      {visits.length === 0 ? (
        <p style={{ ...muted, fontSize: "14px", padding: "32px", margin: 0 }}>No visits recorded yet.</p>
      ) : (
        <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "620px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                {["Time", "Visitor", "Auth", "Location", "Source", "Share", "Device", "Browser", "Duration", "IP"].map((h) => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visits.map((visit, i) => (
                <tr
                  key={visit.id}
                  style={{
                    borderBottom: i < visits.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none",
                    background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.012)"
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Pagination({ page, totalPages, base }) {
  if (totalPages <= 1) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
      {page > 1 ? (
        <Link href={`${base}?page=${page - 1}`} style={paginationLink}>← Previous</Link>
      ) : null}
      <span style={{ color: "#64748b", fontSize: "13px" }}>
        Page {page} of {totalPages}
      </span>
      {page < totalPages ? (
        <Link href={`${base}?page=${page + 1}`} style={paginationLink}>Next →</Link>
      ) : null}
    </div>
  );
}

export default async function VisitsPage({ searchParams }) {
  const page = Math.max(1, Number((await searchParams)?.page) || 1);
  const { visits, total, pageSize } = await getVisitsList(page);
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="admin-page" style={pageStyle}>
      <div className="admin-shell" style={shell}>
        <Header total={total} />
        <div style={{ marginBottom: "14px" }}>
          <Pagination page={page} totalPages={totalPages} base="/admin/visits" />
        </div>
        <VisitTable visits={visits} />
        <div style={{ marginTop: "14px" }}>
          <Pagination page={page} totalPages={totalPages} base="/admin/visits" />
        </div>
      </div>
    </div>
  );
}

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

const paginationLink = {
  padding: "7px 14px",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "9px",
  color: "#cbd5e1",
  fontSize: "13px",
  fontWeight: "700",
  textDecoration: "none"
};
