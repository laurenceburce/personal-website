export default function manifest() {
  return {
    name: "Laurence Finance",
    short_name: "Finance",
    description: "Private personal finance tracker.",
    start_url: "/finance",
    scope: "/",
    display: "standalone",
    background_color: "#07100c",
    theme_color: "#1f8f61",
    orientation: "portrait",
    icons: [
      {
        src: "/favicon-192x192.png",
        sizes: "192x192",
        type: "image/png"
      },
      {
        src: "/logo-512.png",
        sizes: "512x512",
        type: "image/png"
      }
    ],
    shortcuts: [
      {
        name: "Quick Add",
        short_name: "Add",
        description: "Open the transaction form.",
        url: "/finance?tab=transactions",
        icons: [{ src: "/favicon-192x192.png", sizes: "192x192" }]
      },
      {
        name: "Bills",
        short_name: "Bills",
        description: "Open recurring bills.",
        url: "/finance?tab=bills",
        icons: [{ src: "/favicon-192x192.png", sizes: "192x192" }]
      }
    ]
  };
}
