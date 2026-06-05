import Link from "next/link";
import { getVisitsList } from "../../lib/analyticsStore";

export const dynamic = "force-dynamic";

const fmtDate = (iso) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
};

const fmtTime = (seconds) => {
  if (seconds == null) return null;
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
};

const deviceColors = { desktop: "#38bdf8", mobile: "#a78bfa", tablet: "#34d399" };

const badge = (text, color) => (
  <span style={{
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "11px",
    fontWeight: "600",
    background: (color ?? "#94a3b8") + "22",
    color: color ?? "#94a3b8",
    whiteSpace: "nowrap"
  }}>
    {text}
  </span>
);

export default async function VisitsPage({ searchParams }) {
  const page = Math.max(1, Number((await searchParams)?.page) || 1);
  const { visits, total, pageSize } = await getVisitsList(page);
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #080c1c 0%, #040810 100%)",
      fontFamily: "system-ui, -apple-system, sans-serif",
      color: "#f8fafc",
      padding: "32px 24px"
    }}>
      <div style={{ maxWidth: "1200px", margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "28px" }}>
          <div>
            <div style={{ marginBottom: "6px" }}>
              <Link href="/admin" style={{ color: "#475569", fontSize: "13px", textDecoration: "none" }}>
                ← Dashboard
              </Link>
            </div>
            <h1 style={{ fontSize: "22px", fontWeight: "800", margin: "0 0 4px" }}>Visit Log</h1>
            <p style={{ color: "#475569", fontSize: "14px", margin: 0 }}>
              {total.toLocaleString()} total visits
            </p>
          </div>
        </div>

        {/* Table */}
        <div style={{
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "12px",
          overflow: "hidden",
          marginBottom: "20px"
        }}>
          {visits.length === 0 ? (
            <p style={{ color: "#475569", fontSize: "14px", padding: "32px", margin: 0 }}>
              No visits recorded yet.
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                    {["Date / Time", "IP", "Location", "Referrer", "Share Referral", "Device", "Browser", "Time", "Visitor"].map((h) => (
                      <th key={h} style={{
                        textAlign: "left",
                        padding: "12px 16px",
                        color: "#64748b",
                        fontWeight: "600",
                        fontSize: "11px",
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                        whiteSpace: "nowrap"
                      }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visits.map((v, i) => (
                    <tr
                      key={v.id}
                      style={{
                        borderBottom: i < visits.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none",
                        background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)"
                      }}
                    >
                      <td style={{ padding: "11px 16px", color: "#94a3b8", whiteSpace: "nowrap" }}>
                        {fmtDate(v.visitedAt)}
                      </td>
                      <td style={{ padding: "11px 16px", fontFamily: "monospace", fontSize: "12px", color: "#64748b", whiteSpace: "nowrap" }}>
                        {v.ipAddress || <span style={{ color: "#334155" }}>—</span>}
                      </td>
                      <td style={{ padding: "11px 16px", color: "#cbd5e1", whiteSpace: "nowrap" }}>
                        {v.city && v.country
                          ? `${v.city}, ${v.country}`
                          : v.country || <span style={{ color: "#475569" }}>Unknown</span>}
                      </td>
                      <td style={{ padding: "11px 16px", color: "#38bdf8", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {v.referredByIpAddress
                          ? `from: ${v.referredByIpAddress}`
                          : v.referrer || <span style={{ color: "#475569" }}>Direct</span>}
                      </td>
                      <td style={{ padding: "11px 16px", color: "#cbd5e1", whiteSpace: "nowrap" }}>
                        {v.referredByShareId ? (
                          <div>
                            <div style={{ color: "#a78bfa", fontFamily: "monospace", fontSize: "12px" }}>
                              opened {v.referredByShareId}
                            </div>
                          </div>
                        ) : v.createdShareId ? (
                          <div>
                            <div style={{ color: "#34d399", fontFamily: "monospace", fontSize: "12px" }}>
                              created {v.createdShareId}
                            </div>
                            <div style={{ color: "#64748b", fontSize: "11px" }}>
                              shared by this visit
                            </div>
                          </div>
                        ) : (
                          <span style={{ color: "#334155" }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: "11px 16px" }}>
                        {v.deviceType
                          ? badge(v.deviceType, deviceColors[v.deviceType])
                          : <span style={{ color: "#475569" }}>—</span>}
                      </td>
                      <td style={{ padding: "11px 16px", color: "#cbd5e1" }}>
                        {v.browser || <span style={{ color: "#475569" }}>—</span>}
                      </td>
                      <td style={{ padding: "11px 16px", color: "#94a3b8", whiteSpace: "nowrap" }}>
                        {fmtTime(v.timeOnPage) || <span style={{ color: "#334155" }}>—</span>}
                      </td>
                      <td style={{ padding: "11px 16px" }}>
                        {v.email ? (
                          <div>
                            <div style={{ color: "#38bdf8", fontSize: "12px" }}>{v.email}</div>
                            {v.name && <div style={{ color: "#64748b", fontSize: "11px" }}>{v.name}</div>}
                          </div>
                        ) : (
                          <span style={{ color: "#334155", fontFamily: "monospace", fontSize: "11px" }}>
                            {v.visitorId.slice(0, 8)}…
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {page > 1 && (
              <Link href={`/admin/visits?page=${page - 1}`} style={paginationLink}>
                ← Prev
              </Link>
            )}
            <span style={{ color: "#475569", fontSize: "13px" }}>
              Page {page} of {totalPages}
            </span>
            {page < totalPages && (
              <Link href={`/admin/visits?page=${page + 1}`} style={paginationLink}>
                Next →
              </Link>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

const paginationLink = {
  padding: "6px 14px",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "8px",
  color: "#94a3b8",
  fontSize: "13px",
  textDecoration: "none"
};
