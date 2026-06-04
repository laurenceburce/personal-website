import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Laurence Alec Burce | Software Engineer";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "1200px",
          height: "630px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          padding: "80px 96px",
          background: "linear-gradient(135deg, #080c1c 0%, #040810 100%)",
          position: "relative",
          overflow: "hidden"
        }}
      >
        {/* Accent glow */}
        <div
          style={{
            position: "absolute",
            top: "-120px",
            right: "-120px",
            width: "500px",
            height: "500px",
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(56,189,248,0.18) 0%, transparent 70%)",
            display: "flex"
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: "-80px",
            left: "60px",
            width: "300px",
            height: "300px",
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(37,99,235,0.12) 0%, transparent 70%)",
            display: "flex"
          }}
        />

        {/* Accent top bar */}
        <div
          style={{
            position: "absolute",
            top: "0",
            left: "0",
            width: "100%",
            height: "4px",
            background: "linear-gradient(90deg, #38bdf8 0%, #2563eb 100%)",
            display: "flex"
          }}
        />

        {/* Name */}
        <div
          style={{
            fontSize: "72px",
            fontWeight: "800",
            color: "#f8fafc",
            lineHeight: "1.1",
            letterSpacing: "-1px",
            marginBottom: "16px",
            display: "flex"
          }}
        >
          Laurence Alec Burce
        </div>

        {/* Title */}
        <div
          style={{
            fontSize: "32px",
            fontWeight: "500",
            color: "#38bdf8",
            marginBottom: "40px",
            display: "flex"
          }}
        >
          Software Engineer · AI &amp; Automation
        </div>

        {/* Divider */}
        <div
          style={{
            width: "64px",
            height: "3px",
            background: "linear-gradient(90deg, #38bdf8, #2563eb)",
            borderRadius: "2px",
            marginBottom: "40px",
            display: "flex"
          }}
        />

        {/* Tags */}
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          {["Oracle SaaS ERP", "AI Automation", "Copilot Studio", "Next.js"].map((tag) => (
            <div
              key={tag}
              style={{
                padding: "8px 20px",
                borderRadius: "999px",
                border: "1px solid rgba(56,189,248,0.3)",
                color: "#94a3b8",
                fontSize: "20px",
                display: "flex"
              }}
            >
              {tag}
            </div>
          ))}
        </div>

        {/* URL badge */}
        <div
          style={{
            position: "absolute",
            bottom: "48px",
            right: "96px",
            fontSize: "20px",
            color: "#475569",
            display: "flex"
          }}
        >
          laurenceburce.com
        </div>
      </div>
    ),
    { ...size }
  );
}
