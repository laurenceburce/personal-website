import Link from "next/link";
import { getChatLogs } from "../../lib/analyticsStore";
import ChatTable from "./ChatTable";

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



export default async function ChatsPage({ searchParams }) {
  const page = Math.max(1, Number((await searchParams)?.page) || 1);
  const { logs, total, pageSize } = await getChatLogs({ page });
  const totalPages = Math.ceil(total / pageSize);

  function Pagination() {
    if (totalPages <= 1) return null;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        {page > 1 ? (
          <Link href={`/admin/chats?page=${page - 1}`} style={paginationLink}>← Previous</Link>
        ) : null}
        <span style={{ color: "#64748b", fontSize: "13px" }}>
          Page {page} of {totalPages}
        </span>
        {page < totalPages ? (
          <Link href={`/admin/chats?page=${page + 1}`} style={paginationLink}>Next →</Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className="admin-page" style={pageStyle}>
      <div className="admin-shell" style={shell}>
        <Header total={total} />
        <div style={{ marginBottom: "14px" }}>
          <Pagination />
        </div>
        <ChatTable logs={logs} />
        <div style={{ marginTop: "14px" }}>
          <Pagination />
        </div>
      </div>
    </div>
  );
}
