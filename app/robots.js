export default function robots() {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/api/admin", "/finance", "/api/finance"]
    },
    sitemap: "https://laurenceburce.com/sitemap.xml"
  };
}
