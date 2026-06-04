import { getAnalyticsStats, getIdentifiedVisitors } from "../lib/analyticsStore";
import AdminLogout from "./AdminLogout";

export const dynamic = "force-dynamic";

const fmt = (n) =>
  new Intl.NumberFormat("en-US", {
    notation: n >= 10000 ? "compact" : "standard",
    maximumFractionDigits: 1
  }).format(n ?? 0);

const fmtTime = (seconds) => {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
};

const fmtDate = (iso) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
};

const card = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: "12px",
  padding: "20px"
};

const label = { color: "#64748b", fontSize: "12px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "6px" };
const value = { color: "#f8fafc", fontSize: "28px", fontWeight: "800" };
const sectionTitle = { color: "#94a3b8", fontSize: "12px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "14px" };
const row = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" };
const rowLabel = { color: "#cbd5e1", fontSize: "14px" };
const rowCount = { color: "#38bdf8", fontSize: "14px", fontWeight: "600" };
const badge = (color) => ({
  display: "inline-block", padding: "2px 8px", borderRadius: "999px",
  fontSize: "12px", fontWeight: "600",
  background: color + "22", color
});

export default async function AdminPage() {
  const [stats, identified] = await Promise.all([
    getAnalyticsStats(),
    getIdentifiedVisitors()
  ]);

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #080c1c 0%, #040810 100%)",
      fontFamily: "system-ui, -apple-system, sans-serif",
      color: "#f8fafc",
      padding: "32px 24px"
    }}>
      <div style={{ maxWidth: "1100px", margin: "0 auto" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "32px" }}>
          <div>
            <h1 style={{ fontSize: "22px", fontWeight: "800", margin: "0 0 4px" }}>Analytics Dashboard</h1>
            <p style={{ color: "#475569", fontSize: "14px", margin: 0 }}>laurenceburce.com</p>
          </div>
          <AdminLogout />
        </div>

        {/* Summary stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "16px", marginBottom: "24px" }}>
          {[
            { label: "Total Visits", val: fmt(stats.totalVisits) },
            { label: "Unique Visitors", val: fmt(stats.uniqueVisitors) },
            { label: "Identified", val: fmt(stats.identifiedVisitors) },
            { label: "Avg Time on Page", val: fmtTime(stats.avgTimeOnPageSeconds) }
          ].map(({ label: l, val: v }) => (
            <div key={l} style={card}>
              <p style={label}>{l}</p>
              <p style={{ ...value, margin: 0 }}>{v}</p>
            </div>
          ))}
        </div>

        {/* Middle grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px", marginBottom: "24px" }}>

          {/* Countries */}
          <div style={card}>
            <p style={sectionTitle}>Top Countries</p>
            {stats.topCountries.length === 0
              ? <p style={{ color: "#475569", fontSize: "14px" }}>No data yet</p>
              : stats.topCountries.map(({ country, count }) => (
                <div key={country} style={row}>
                  <span style={rowLabel}>{country}</span>
                  <span style={rowCount}>{fmt(count)}</span>
                </div>
              ))}
          </div>

          {/* Referrers */}
          <div style={card}>
            <p style={sectionTitle}>Top Referrers</p>
            {stats.topReferrers.length === 0
              ? <p style={{ color: "#475569", fontSize: "14px" }}>No data yet</p>
              : stats.topReferrers.map(({ referrer, count }) => (
                <div key={referrer} style={row}>
                  <span style={rowLabel}>{referrer}</span>
                  <span style={rowCount}>{fmt(count)}</span>
                </div>
              ))}
          </div>

          {/* Devices */}
          <div style={card}>
            <p style={sectionTitle}>Devices</p>
            {stats.deviceBreakdown.length === 0
              ? <p style={{ color: "#475569", fontSize: "14px" }}>No data yet</p>
              : stats.deviceBreakdown.map(({ device, count }) => {
                const colors = { desktop: "#38bdf8", mobile: "#a78bfa", tablet: "#34d399" };
                return (
                  <div key={device} style={row}>
                    <span style={badge(colors[device] ?? "#94a3b8")}>{device}</span>
                    <span style={rowCount}>{fmt(count)}</span>
                  </div>
                );
              })}
          </div>

          {/* Browsers */}
          <div style={card}>
            <p style={sectionTitle}>Browsers</p>
            {stats.browserBreakdown.length === 0
              ? <p style={{ color: "#475569", fontSize: "14px" }}>No data yet</p>
              : stats.browserBreakdown.map(({ browser, count }) => (
                <div key={browser} style={row}>
                  <span style={rowLabel}>{browser}</span>
                  <span style={rowCount}>{fmt(count)}</span>
                </div>
              ))}
          </div>

          {/* Downloads */}
          <div style={card}>
            <p style={sectionTitle}>Downloads</p>
            {stats.topDownloads.length === 0
              ? <p style={{ color: "#475569", fontSize: "14px" }}>No downloads yet</p>
              : stats.topDownloads.map(({ file, count }) => (
                <div key={file} style={row}>
                  <span style={rowLabel}>{file}</span>
                  <span style={rowCount}>{fmt(count)}</span>
                </div>
              ))}
          </div>

        </div>

        {/* Identified visitors */}
        <div style={card}>
          <p style={sectionTitle}>Identified Visitors ({identified.visitors.length})</p>
          {identified.visitors.length === 0
            ? <p style={{ color: "#475569", fontSize: "14px" }}>No identified visitors yet. They appear here after someone submits the contact form.</p>
            : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                  <thead>
                    <tr>
                      {["Name", "Email", "Last Seen"].map((h) => (
                        <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#64748b", fontWeight: "600", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {identified.visitors.map((v) => (
                      <tr key={v.visitorId} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                        <td style={{ padding: "10px 12px", color: "#cbd5e1" }}>{v.name || "—"}</td>
                        <td style={{ padding: "10px 12px", color: "#38bdf8" }}>{v.email}</td>
                        <td style={{ padding: "10px 12px", color: "#475569" }}>{fmtDate(v.lastSeenAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>

      </div>
    </div>
  );
}
