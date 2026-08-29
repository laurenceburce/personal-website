import { redirect } from "next/navigation";
import JobSearchLoginClient from "./JobSearchLoginClient";
import { getJobSearchAccess } from "../../lib/jobSearchAuth";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Job Search Sign In",
  robots: {
    index: false,
    follow: false
  }
};

function cleanCallback(value) {
  if (typeof value !== "string") return "/job-search";
  if (!value.startsWith("/job-search")) return "/job-search";
  if (value.startsWith("/job-search/login")) return "/job-search";
  return value;
}

export default async function JobSearchLoginPage({ searchParams }) {
  const params = await searchParams;
  const callbackUrl = cleanCallback(params?.callbackUrl);
  const access = await getJobSearchAccess();

  if (access.authorized) redirect(callbackUrl);

  return (
    <JobSearchLoginClient
      callbackUrl={callbackUrl}
      currentEmail={access.email}
      isSignedIn={Boolean(access.session)}
    />
  );
}
