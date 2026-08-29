import { NextResponse } from "next/server";
import { requireJobSearchAccess } from "./jobSearchAuth";

// Shared by every app/api/job-search/**/route.js file so the auth-guard and
// error-shape boilerplate isn't repeated across all of them (finance only ever
// needed one route file, so this pattern never came up there).
export async function requireAccessOrRespond() {
  const access = await requireJobSearchAccess();
  if (!access) {
    return { access: null, unauthorizedResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { access, unauthorizedResponse: null };
}

export function jsonError(error) {
  const status = Number(error?.status) || 500;
  return NextResponse.json({ error: error?.message || "Something went wrong." }, { status });
}
