import Link from "next/link";
import { getAnalyticsStats, getIdentifiedVisitors } from "../lib/analyticsStore";
import AdminLogout from "./AdminLogout";

export const dynamic = "force-dynamic";

const pageStyle = {
  minHeight: "100vh",
  background: "linear-gradient(135deg, #080c1c 0%, #040810 100%)",
  fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  color: "#f8fafc",
  padding: "32px 24px"
};

const shell = { maxWidth: "1180px", margin: "0 auto" };
const card = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: "14px",
  padding: "18px",
  boxShadow: "0 18px 50px rgba(0,0,0,0.18)"
};
const panelHeader = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "12px",
  marginBottom: "14px"
};
const sectionTitle = {
  color: "#cbd5e1",
  fontSize: "12px",
  fontWeight: "800",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  margin: 0
};
const muted = { color: "#64748b" };
const row = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: "12px",
  alignItems: "center",
  padding: "9px 0",
  borderBottom: "1px solid rgba(255,255,255,0.05)"
};

const fmt = (n) =>
  new Intl.NumberFormat("en-US", {
    notation: n >= 10000 ? "compact" : "standard",
    maximumFractionDigits: 1
  }).format(n ?? 0);

const fmtTime = (seconds) => {
  if (seconds == null) return "-";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
};

const fmtDate = (iso) => {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
};

const fmtVisitor = (event) => {
  if (event.name && event.email) return `${event.name} <${event.email}>`;
  if (event.email) return event.email;
  return `Anonymous ${event.visitorId?.slice(0, 8) || "visitor"}`;
};

const fmtAuthProvider = (provider) => {
  const labels = {
    google: "Google",
    github: "GitHub",
    linkedin: "LinkedIn",
    "microsoft-entra-id": "Microsoft"
  };

  return labels[provider] || provider || "-";
};

const fmtEventValue = (value) => {
  if (!value) return "-";
  return value.length > 76 ? `${value.slice(0, 73)}...` : value;
};

const sumCounts = (items) => items.reduce((sum, item) => sum + Number(item.count || 0), 0);

function Header() {
  return (
    <div className="admin-header" style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
      gap: "18px",
      marginBottom: "28px"
      }}>
      <div>
        <p style={{ ...sectionTitle, color: "#38bdf8", marginBottom: "8px" }}>Portfolio Admin</p>
        <h1 style={{ fontSize: "28px", lineHeight: 1.1, fontWeight: "850", margin: "0 0 8px" }}>
          Analytics Overview
        </h1>
        <p style={{ ...muted, fontSize: "14px", margin: 0 }}>
          Traffic, engagement, downloads, and known visitors for laurenceburce.com.
        </p>
      </div>
      <div className="admin-header-actions" style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
        <Link href="/admin/visits" style={primaryLink}>Visit Log</Link>
        <AdminLogout />
      </div>
    </div>
  );
}

function MetricCard({ label, value, note }) {
  return (
    <div style={card}>
      <p style={{ ...sectionTitle, color: "#64748b", marginBottom: "10px" }}>{label}</p>
      <p style={{ color: "#f8fafc", fontSize: "30px", fontWeight: "850", lineHeight: 1, margin: "0 0 8px" }}>
        {value}
      </p>
      <p style={{ ...muted, fontSize: "12px", margin: 0 }}>{note}</p>
    </div>
  );
}

function RankedList({ title, items, getLabel, emptyText = "No data yet" }) {
  const max = Math.max(...items.map((item) => item.count), 1);

  return (
    <div style={card}>
      <div style={panelHeader}>
        <p style={sectionTitle}>{title}</p>
        <span style={{ ...muted, fontSize: "12px" }}>{items.length} rows</span>
      </div>
      {items.length === 0 ? (
        <p style={{ ...muted, fontSize: "14px", margin: 0 }}>{emptyText}</p>
      ) : (
        items.map((item) => (
          <div key={getLabel(item)} className="admin-list-row" style={row}>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "#dbeafe", fontSize: "13px", fontWeight: "650", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {getLabel(item)}
              </div>
              <div style={{ height: "5px", borderRadius: "999px", background: "rgba(255,255,255,0.06)", marginTop: "7px", overflow: "hidden" }}>
                <div style={{
                  width: `${Math.max(8, (item.count / max) * 100)}%`,
                  height: "100%",
                  borderRadius: "inherit",
                  background: "linear-gradient(90deg, #475569, #94a3b8)"
                }} />
              </div>
            </div>
            <span style={{ color: "#f8fafc", fontSize: "13px", fontWeight: "800" }}>{fmt(item.count)}</span>
          </div>
        ))
      )}
    </div>
  );
}

function ActivityList({ title, items, type }) {
  return (
    <div style={card}>
      <div style={panelHeader}>
        <p style={sectionTitle}>{title}</p>
        <span style={{ ...muted, fontSize: "12px" }}>latest {items.length}</span>
      </div>
      {items.length === 0 ? (
        <p style={{ ...muted, fontSize: "14px", margin: 0 }}>No {type} events yet</p>
      ) : (
        items.slice(0, 8).map((event) => (
          <div key={`${event.createdAt}-${event.visitorId}-${event.file || event.link}`} className="admin-list-row admin-activity-row" style={{ ...row, alignItems: "start" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "#e2e8f0", fontSize: "13px", fontWeight: "700", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {fmtEventValue(event.file || event.link)}
              </div>
              <div style={{ ...muted, fontSize: "12px", marginTop: "3px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {fmtVisitor(event)}
                {event.authProvider ? ` - ${fmtAuthProvider(event.authProvider)}` : ""}
              </div>
            </div>
            <span style={{ color: "#94a3b8", fontSize: "12px", whiteSpace: "nowrap" }}>{fmtDate(event.createdAt)}</span>
          </div>
        ))
      )}
    </div>
  );
}

function IdentifiedVisitors({ visitors }) {
  return (
    <div style={card}>
      <div style={panelHeader}>
        <p style={sectionTitle}>Identified Visitors</p>
        <span style={{ ...muted, fontSize: "12px" }}>{visitors.length} people</span>
      </div>
      {visitors.length === 0 ? (
        <p style={{ ...muted, fontSize: "14px", margin: 0 }}>
          No identified visitors yet. They appear here after someone submits the contact form.
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr>
                {["Name", "Email", "Provider", "Last Seen"].map((h) => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visitors.map((v) => (
                <tr key={v.visitorId} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  <td style={td}>{v.name || "-"}</td>
                  <td style={{ ...td, color: "#bae6fd" }}>{v.email}</td>
                  <td style={{ ...td, color: "#94a3b8", whiteSpace: "nowrap" }}>{fmtAuthProvider(v.authProvider)}</td>
                  <td style={{ ...td, color: "#94a3b8", whiteSpace: "nowrap" }}>{fmtDate(v.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default async function AdminPage() {
  const [stats, identified] = await Promise.all([
    getAnalyticsStats(),
    getIdentifiedVisitors()
  ]);
  const totalEngagement = sumCounts(stats.topDownloads) + sumCounts(stats.topLinkClicks);
  const identifiedRate = stats.uniqueVisitors > 0
    ? `${Math.round((stats.identifiedVisitors / stats.uniqueVisitors) * 100)}%`
    : "0%";

  return (
    <div className="admin-page" style={pageStyle}>
      <div className="admin-shell" style={shell}>
        <Header />

        <div className="admin-metric-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "14px", marginBottom: "18px" }}>
          <MetricCard label="Total Visits" value={fmt(stats.totalVisits)} note="All recorded sessions" />
          <MetricCard label="Unique Visitors" value={fmt(stats.uniqueVisitors)} note="Known browser identities" />
          <MetricCard label="Identified Rate" value={identifiedRate} note={`${fmt(stats.identifiedVisitors)} identified visitors`} />
          <MetricCard label="Avg Time" value={fmtTime(stats.avgTimeOnPageSeconds)} note="Average tracked page duration" />
          <MetricCard label="Engagement" value={fmt(totalEngagement)} note="Downloads and link clicks" />
        </div>

        <div className="admin-dashboard-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(280px, 0.9fr)", gap: "18px", marginBottom: "18px" }}>
          <div className="admin-ranked-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "14px" }}>
            <RankedList title="Countries" items={stats.topCountries} getLabel={(item) => item.country} />
            <RankedList title="Referrers" items={stats.topReferrers} getLabel={(item) => item.referrer} />
            <RankedList title="Devices" items={stats.deviceBreakdown} getLabel={(item) => item.device} />
            <RankedList title="Browsers" items={stats.browserBreakdown} getLabel={(item) => item.browser} />
          </div>

          <div className="admin-side-grid" style={{ display: "grid", gap: "14px" }}>
            <RankedList title="Top Downloads" items={stats.topDownloads} getLabel={(item) => item.file} emptyText="No downloads yet" />
            <RankedList title="Top Links" items={stats.topLinkClicks.slice(0, 8)} getLabel={(item) => item.link} emptyText="No link clicks yet" />
          </div>
        </div>

        <div className="admin-activity-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "14px", marginBottom: "18px" }}>
          <ActivityList title="Recent Downloads" items={stats.downloadEvents} type="download" />
          <ActivityList title="Recent Link Clicks" items={stats.linkClickEvents} type="link click" />
        </div>

        <IdentifiedVisitors visitors={identified.visitors} />
      </div>
    </div>
  );
}

const primaryLink = {
  padding: "9px 15px",
  background: "rgba(56,189,248,0.1)",
  border: "1px solid rgba(56,189,248,0.22)",
  borderRadius: "9px",
  color: "#7dd3fc",
  fontSize: "13px",
  fontWeight: "700",
  textDecoration: "none"
};

const th = {
  textAlign: "left",
  padding: "9px 12px",
  color: "#64748b",
  fontWeight: "800",
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  borderBottom: "1px solid rgba(255,255,255,0.08)"
};

const td = {
  padding: "11px 12px",
  color: "#cbd5e1",
  verticalAlign: "top"
};
