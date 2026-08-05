import { auth, isFinanceAuthorizedEmail } from "../../auth";
import { FINANCE_OWNER_EMAIL } from "./financeStore";

export async function getFinanceAccess() {
  if (process.env.NODE_ENV !== "production" && process.env.FINANCE_DEV_BYPASS === "true") {
    return {
      session: {
        user: {
          email: FINANCE_OWNER_EMAIL,
          isFinanceAuthorized: true
        }
      },
      email: FINANCE_OWNER_EMAIL,
      authorized: true
    };
  }

  const session = await auth();
  const email = session?.user?.email || "";

  return {
    session,
    email,
    authorized: isFinanceAuthorizedEmail(email)
  };
}

export async function requireFinanceAccess() {
  const access = await getFinanceAccess();
  if (!access.authorized) return null;
  return access;
}
