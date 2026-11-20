import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as access from "../app/lib/financeAccess.mjs";

const require = createRequire(import.meta.url);
const { transformSync } = require("next/dist/build/swc");
const compile = (source) => transformSync(source, {
  jsc: { parser: { syntax: "ecmascript", jsx: true }, target: "es2022", transform: { react: { runtime: "automatic" } } },
  module: { type: "commonjs" },
}).code;
const authCode = compile(await readFile(new URL("../auth.js", import.meta.url), "utf8"));
const financeAuthCode = compile(await readFile(new URL("../app/lib/financeAuth.js", import.meta.url), "utf8"));
const providerCode = compile(await readFile(new URL("../app/components/auth/AuthProviderButtons.js", import.meta.url), "utf8"));
const loginCode = compile(await readFile(new URL("../app/finance/login/FinanceLoginClient.js", import.meta.url), "utf8"));
const pageCode = compile(await readFile(new URL("../app/finance/page.js", import.meta.url), "utf8"));
const owner = "laurenceburce@gmail.com";

function environment(t) {
  const keys = ["NODE_ENV", "FINANCE_ALLOWED_EMAILS", "FINANCE_DEV_BYPASS"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = "test";
  process.env.FINANCE_ALLOWED_EMAILS = owner;
  delete process.env.FINANCE_DEV_BYPASS;
  t.after(() => {
    for (const key of keys) original[key] === undefined ? delete process.env[key] : process.env[key] = original[key];
  });
}

function backend() {
  let configuration;
  let session = null;
  let authCalls = 0;
  const authModule = { exports: {} };
  new Function("require", "module", "exports", authCode)((name) => {
    if (name === "next-auth") return (value) => {
      configuration = value;
      return { handlers: { GET() {}, POST() {} }, auth: async () => { authCalls++; return session; } };
    };
    if (name.startsWith("next-auth/providers/")) return (value) => value;
    if (name === "./app/lib/financeAccess.mjs") return access;
    throw new Error(`Unexpected auth dependency: ${name}`);
  }, authModule, authModule.exports);
  const financeModule = { exports: {} };
  new Function("require", "module", "exports", financeAuthCode)((name) => {
    if (name === "../../auth") return authModule.exports;
    if (name === "./financeStore") return { FINANCE_OWNER_EMAIL: owner };
    if (name === "./financeAccess.mjs") return access;
    throw new Error(`Unexpected finance auth dependency: ${name}`);
  }, financeModule, financeModule.exports);
  return { callbacks: configuration.callbacks, api: financeModule.exports,
    setSession(value) { session = value; }, calls: () => authCalls };
}

test("new identity proofs require a verified matching email and never trust Microsoft email alone", async () => {
  for (const provider of ["google", "linkedin"]) {
    assert.equal(await access.verifyFinanceEmail({ account: { provider }, email: owner,
      profile: { email: ` ${owner.toUpperCase()} `, email_verified: true } }), true);
    for (const profile of [{ email: owner }, { email: owner, email_verified: false },
      { email: owner, email_verified: "true" }, { email: "someone@example.com", email_verified: true }])
      assert.equal(await access.verifyFinanceEmail({ account: { provider }, email: owner, profile }), false);
  }
  for (const provider of ["microsoft-entra-id", "unknown", ""])
    assert.equal(await access.verifyFinanceEmail({ account: { provider }, email: owner,
      profile: { email: owner, email_verified: true } }), false);
});

test("GitHub finance proof uses a verified address from its authenticated email endpoint and fails closed", async () => {
  const identity = { account: { provider: "github", access_token: "test-token" }, email: owner, profile: { email: owner } };
  let request;
  const fetcher = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => [{ email: "other@example.com", verified: true }, { email: owner, verified: true }] };
  };
  assert.equal(await access.verifyFinanceEmail(identity, fetcher), true);
  assert.equal(request.url, "https://api.github.com/user/emails");
  assert.equal(request.options.headers.Authorization, "Bearer test-token");
  assert.equal(request.options.cache, "no-store");
  assert.ok(request.options.signal instanceof AbortSignal);
  for (const result of [[], [{ email: owner, verified: false }], [{ email: owner, verified: "true" }],
    [{ email: "other@example.com", verified: true }], { email: owner, verified: true }])
    assert.equal(await access.verifyFinanceEmail(identity, async () => ({ ok: true, json: async () => result })), false);
  assert.equal(await access.verifyFinanceEmail(identity, async () => ({ ok: false })), false);
  assert.equal(await access.verifyFinanceEmail(identity, async () => { throw new Error("Timeout"); }), false);
  assert.equal(await access.verifyFinanceEmail({ ...identity, account: { provider: "github" } },
    async () => { throw new Error("Must not request without a token"); }), false);
});

test("new sign-ins store server proof and client session updates cannot upgrade finance access", async (t) => {
  environment(t);
  const { callbacks } = backend();
  for (const verified of [true, false]) {
    const token = await callbacks.jwt({ token: { email: owner }, account: { provider: "google" },
      profile: { email: owner, email_verified: verified } });
    assert.equal(token.financeEmailVerified, verified);
    const session = await callbacks.session({ session: { user: { email: "client@example.com", financeEmailVerified: !verified } }, token });
    assert.equal(session.user.email, owner);
    assert.equal(session.user.financeEmailVerified, verified);
    assert.equal(session.user.isFinanceAuthorized, verified);
  }
  const original = { email: "outsider@example.com", provider: "google", financeEmailVerified: false };
  const token = await callbacks.jwt({ token: { ...original }, trigger: "update",
    session: { user: { email: owner, provider: "google", financeEmailVerified: true, isFinanceAuthorized: true } } });
  assert.deepEqual(token, original);
  const session = await callbacks.session({ token, session: { user: { email: owner, financeEmailVerified: true } } });
  assert.equal(session.user.isFinanceAuthorized, false);
  assert.equal(session.user.email, "outsider@example.com");
});

test("signed legacy owner Google and GitHub sessions retain access while explicit failed proof always denies", async (t) => {
  environment(t);
  const { callbacks, api, setSession } = backend();
  for (const provider of ["google", "github", "linkedin", "microsoft-entra-id", ""]) {
    const session = await callbacks.session({ token: { email: owner, provider },
      session: { user: { email: owner, financeEmailVerified: true, isFinanceAuthorized: true } } });
    const allowed = ["google", "github"].includes(provider);
    assert.equal(session.user.isFinanceAuthorized, allowed, provider);
    assert.equal(Object.hasOwn(session.user, "financeEmailVerified"), false);
    setSession(session);
    assert.equal((await api.getFinanceAccess()).authorized, allowed);
    setSession({ user: { email: owner, provider, financeEmailVerified: false, isFinanceAuthorized: true } });
    assert.equal(await api.requireFinanceAccess(), null, "a failed proof cannot use the legacy-provider fallback");
  }
  setSession({ user: { email: "outsider@example.com", provider: "google", financeEmailVerified: true } });
  assert.equal(await api.requireFinanceAccess(), null, "proof never bypasses the configured owner allowlist");
  setSession({ user: { email: owner, provider: "linkedin", financeEmailVerified: true } });
  assert.equal((await api.requireFinanceAccess()).authorized, true);
});

test("the development bypass remains disabled in production and no client authorization flag is sufficient", async (t) => {
  environment(t);
  const { api, setSession, calls } = backend();
  process.env.FINANCE_DEV_BYPASS = "true";
  assert.equal((await api.getFinanceAccess()).authorized, true);
  assert.equal(calls(), 0);
  process.env.NODE_ENV = "production";
  setSession({ user: { email: owner, isFinanceAuthorized: true } });
  assert.equal(await api.requireFinanceAccess(), null);
  assert.equal(calls(), 1);
});

test("finance sign-in filters configured providers while portfolio sign-in keeps all options", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const configured = Object.fromEntries(["google", "github", "linkedin", "microsoft-entra-id"].map((id) => [id, { id, name: id }]));
  const renderProviders = async (payload, allowedProviders, ok = true) => {
    const cells = [];
    const effects = [];
    const statuses = [];
    let cursor = 0;
    let first = true;
    globalThis.fetch = async (url) => {
      assert.equal(url, "/api/auth/providers");
      return { ok, json: async () => payload };
    };
    const module = { exports: {} };
    new Function("require", "module", "exports", providerCode)((name) => {
      if (name === "react") return { ...React,
        useState(initial) {
          const index = cursor++;
          if (!Object.hasOwn(cells, index)) cells[index] = initial;
          return [cells[index], (value) => { cells[index] = value; }];
        }, useEffect(effect) { if (first) effects.push(effect); } };
      if (name === "next-auth/react") return { signIn() {} };
      return require(name);
    }, module, module.exports);
    const props = { allowedProviders, onStatusChange: (value) => statuses.push(value) };
    module.exports.default(props);
    for (const effect of effects) effect();
    await new Promise(setImmediate);
    cursor = 0;
    first = false;
    return { html: renderToStaticMarkup(module.exports.default(props)), statuses };
  };
  const finance = await renderProviders(configured, ["google", "github", "linkedin"]);
  for (const provider of ["Google", "GitHub", "LinkedIn"]) assert.match(finance.html, new RegExp(`Sign in with ${provider}`));
  assert.doesNotMatch(finance.html, /Sign in with Microsoft/);
  const portfolio = await renderProviders(configured);
  assert.match(portfolio.html, /Sign in with Microsoft/);
  const none = await renderProviders({ "microsoft-entra-id": configured["microsoft-entra-id"] }, ["google", "github", "linkedin"]);
  assert.doesNotMatch(none.html, /<button/);
  assert.match(none.statuses.at(-1), /Verified-email sign-in is not configured/);
  const failed = await renderProviders({}, ["google", "github", "linkedin"], false);
  assert.match(failed.statuses.at(-1), /Unable to load sign-in options/);
});

test("finance login and restricted-owner screens explain verified-email sign-in", async () => {
  const loginModule = { exports: {} };
  new Function("require", "module", "exports", loginCode)((name) => {
    if (name === "react") return { ...React, useState: () => ["", () => {}] };
    if (name === "next-auth/react") return { signOut() {} };
    if (name === "../../components/auth/AuthProviderButtons") return (props) => React.createElement("div", {
      "data-providers": props.allowedProviders.join(","),
    });
    return require(name);
  }, loginModule, loginModule.exports);
  const login = renderToStaticMarkup(React.createElement(loginModule.exports.default, {
    isSignedIn: true, currentEmail: owner, currentProvider: "microsoft-entra-id",
  }));
  assert.match(login, /For finance, choose Google, GitHub or LinkedIn/);
  assert.match(login, /data-providers="google,github,linkedin"/);
  for (const emailAllowed of [true, false]) {
    const pageModule = { exports: {} };
    new Function("require", "module", "exports", pageCode)((name) => {
      if (name === "next/navigation") return { redirect() { throw new Error("Unexpected redirect"); } };
      if (name === "./FinanceAppClient") return () => null;
      if (name === "../lib/financeAuth") return { getFinanceAccess: async () => ({ session: { user: { email: owner } },
        authorized: false, emailAllowed }) };
      if (name === "../lib/financePlannerStore" || name === "../lib/financeStore") return {};
      if (name === "../lib/financePlanner.mjs") return { localDate: () => "2026-11-20" };
      if (name === "../lib/financeLivePlanner.mjs") return { getLivePlannerRange: () => ({ startDate: "2026-11-06", endDate: "2027-02-18" }) };
      return require(name);
    }, pageModule, pageModule.exports);
    const html = renderToStaticMarkup(await pageModule.exports.default({ searchParams: {} }));
    assert.match(html, emailAllowed ? /Verify your sign-in/ : /Access restricted/);
    assert.match(html, emailAllowed ? /Sign in with a verified email/ : /Use another account/);
  }
});
