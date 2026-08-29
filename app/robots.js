export default function robots() {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/api/admin", "/finance", "/api/finance", "/job-search", "/api/job-search"]
    },
    sitemap: "https://laurenceburce.com/sitemap.xml"
  };
}
