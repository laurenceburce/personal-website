export function GET() {
  return Response.json(
    {
      id: "/finance",
      name: "Personal Finance",
      short_name: "Finance",
      description: "Your private salary, bills, spending, and budget planner.",
      start_url: "/finance",
      scope: "/finance",
      display: "standalone",
      background_color: "#f7f8fa",
      theme_color: "#16765b",
      icons: [
        {
          src: "/finance-icon-192.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "/finance-icon-512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "/finance-icon.svg",
          sizes: "any",
          type: "image/svg+xml",
          purpose: "any",
        },
      ],
      shortcuts: [
        {
          name: "Quick transaction",
          url: "/finance?tab=transactions&quick=1",
          description: "Quickly record one-time income or an expense.",
        },
        {
          name: "Bills",
          url: "/finance?tab=bills",
          description: "Manage monthly and annual bills.",
        },
        {
          name: "Budget plans",
          url: "/finance?tab=plans",
          description: "Open your dated budget plans.",
        },
      ],
    },
    {
      headers: {
        "Content-Type": "application/manifest+json",
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
}
