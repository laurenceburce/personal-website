import { auth, isFinanceAuthorizedEmail } from "../../auth";
import { FINANCE_OWNER_EMAIL } from "./financeStore";
import { hasFinanceEmailProof } from "./financeAccess.mjs";

export async function getFinanceAccess() {
  if (process.env.NODE_ENV !== "production" && process.env.FINANCE_DEV_BYPASS === "true") {
    return {
      session: {
        user: {
          email: FINANCE_OWNER_EMAIL,
          financeEmailVerified: true,
          isFinanceAuthorized: true
        }
      },
      email: FINANCE_OWNER_EMAIL,
      emailAllowed: true,
      authorized: true
    };
  }

  const session = await auth();
  const email = session?.user?.email || "";
  const emailAllowed = isFinanceAuthorizedEmail(email);

  return {
    session,
    email,
    emailAllowed,
    authorized: emailAllowed && hasFinanceEmailProof(session?.user)
  };
}

export async function requireFinanceAccess() {
  const access = await getFinanceAccess();
  if (!access.authorized) return null;
  return access;
}
