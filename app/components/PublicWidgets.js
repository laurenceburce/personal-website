"use client";

import { usePathname } from "next/navigation";
import AuthSessionTracker from "./auth/AuthSessionTracker";
import AuthWelcome from "./auth/AuthWelcome";
import ChatWidget from "./chat/ChatWidget";

const PRIVATE_PREFIXES = ["/admin", "/finance", "/job-search"];

export default function PublicWidgets() {
  const pathname = usePathname() || "";
  const isPrivateRoute = PRIVATE_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ));

  if (isPrivateRoute) return null;

  return (
    <>
      <AuthSessionTracker />
      <AuthWelcome />
      <ChatWidget />
    </>
  );
}
