import { auth, isJobSearchAuthorizedEmail } from "../../auth";

const JOB_SEARCH_OWNER_EMAIL = "laurenceburce@gmail.com";

export async function getJobSearchAccess() {
  if (process.env.NODE_ENV !== "production" && process.env.JOB_SEARCH_DEV_BYPASS === "true") {
    return {
      session: {
        user: {
          email: JOB_SEARCH_OWNER_EMAIL,
          isJobSearchAuthorized: true
        }
      },
      email: JOB_SEARCH_OWNER_EMAIL,
      authorized: true
    };
  }

  const session = await auth();
  const email = session?.user?.email || "";

  return {
    session,
    email,
    authorized: isJobSearchAuthorizedEmail(email)
  };
}

export async function requireJobSearchAccess() {
  const access = await getJobSearchAccess();
  if (!access.authorized) return null;
  return access;
}
