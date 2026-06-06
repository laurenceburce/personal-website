import Link from "next/link";
import { getChatLogs } from "../../lib/analyticsStore";

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

const fmtDate = (iso) => {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
};

const truncate = (text, max) =>
  text && text.length > max ? `${text.slice(0, max)}…` : (text || "-");

function Header({ total }) {
  return (
    <div style={{
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
          Chat Logs
        </h1>
        <p style={{ ...muted, fontSize: "14px", margin: 0 }}>
          {total.toLocaleString()} conversations logged, newest first.
        </p>
      </div>
    </div>
  );
}

function RecentCards({ logs }) {
  return (
    <div style={{ ...card, padding: "18px", marginBottom: "18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "12px", marginBottom: "14px" }}>
        <p style={sectionTitle}>Recent Conversations</p>
        <span style={{ ...muted, fontSize: "12px" }}>latest {Math.min(logs.length, 6)}</span>
      </div>
      {logs.length === 0 ? (
        <p style={{ ...muted, fontSize: "14px", margin: 0 }}>No conversations yet.</p>
      ) : (
        <div className="admin-session-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "12px" }}>
          {logs.slice(0, 6).map((log) => (
            <div key={log.id} style={{
              border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: "12px",
              padding: "14px",
              background: "rgba(255,255,255,0.025)"
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", marginBottom: "8px" }}>
                <span style={{ color: "#bae6fd", fontSize: "13px", fontWeight: "700", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {log.email || "Anonymous"}
                </span>
                <span style={{ ...muted, fontSize: "12px", whiteSpace: "nowrap" }}>{fmtDate(log.createdAt)}</span>
              </div>
              <p style={{ color: "#e2e8f0", fontSize: "13px", margin: "0 0 8px", lineHeight: 1.5 }}>
                <span style={{ ...muted, fontWeight: "700" }}>Q: </span>
                {truncate(log.userMessage, 120)}
              </p>
              <p style={{ color: "#94a3b8", fontSize: "13px", margin: 0, lineHeight: 1.5 }}>
                <span style={{ fontWeight: "700" }}>A: </span>
                {truncate(log.aiResponse, 140)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChatTable({ logs }) {
  return (
    <div style={{ ...card, overflow: "hidden", marginBottom: "20px" }}>
      <div style={{ padding: "16px 18px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <p style={sectionTitle}>Detailed Records</p>
      </div>
      {logs.length === 0 ? (
        <p style={{ ...muted, fontSize: "14px", padding: "32px", margin: 0 }}>No conversations yet.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
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
                  <td style={{ ...td, maxWidth: "260px" }}>
                    <div style={{ color: "#e2e8f0", lineHeight: 1.5 }}>{truncate(log.userMessage, 160)}</div>
                  </td>
                  <td style={{ ...td, maxWidth: "320px" }}>
                    <div style={{ color: "#94a3b8", lineHeight: 1.5 }}>{truncate(log.aiResponse, 200)}</div>
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

export default async function ChatsPage({ searchParams }) {
  const page = Math.max(1, Number((await searchParams)?.page) || 1);
  const { logs, total, pageSize } = await getChatLogs({ page });
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="admin-page" style={pageStyle}>
      <div className="admin-shell" style={shell}>
        <Header total={total} />
        <RecentCards logs={logs} />
        <ChatTable logs={logs} />

        {totalPages > 1 && (
          <div className="admin-pagination" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            {page > 1 ? (
              <Link href={`/admin/chats?page=${page - 1}`} style={paginationLink}>Previous</Link>
            ) : null}
            <span style={{ color: "#64748b", fontSize: "13px" }}>
              Page {page} of {totalPages}
            </span>
            {page < totalPages ? (
              <Link href={`/admin/chats?page=${page + 1}`} style={paginationLink}>Next</Link>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
