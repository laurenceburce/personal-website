import { addDays, localDate } from "./financePlanner.mjs";

const supportedDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" || value > "2200-12-31") return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? value : null;
};

export function createPrimaryFinancePlan(currentDate = localDate()) {
  return {
    id: "live-planner", name: "Live planner", continuous: true, balanceMode: "live",
    startDate: currentDate, endDate: addDays(currentDate, 365) > "2200-12-31" ? "2200-12-31" : addDays(currentDate, 365),
    openingUsd: 0, openingPhp: 0, openingReserveUsd: 0, openingReservePhp: 0,
    accountOpeningBalances: [], startingAccounts: [], completedRows: [], rowOverrides: [], rowOrder: [],
    includeIncome: true, includeTransactions: true, includeAllocations: true, includeAnnualReserve: true,
    entries: [],
  };
}

/** Keep one ongoing primary planner without changing any saved entry or receipt identity. */
export function ensurePrimaryFinancePlanner(document, currentDate = localDate()) {
  if (!document || !Array.isArray(document.plans)) return document;
  if (!document.plans.length) return { ...document, plans: [createPrimaryFinancePlan(currentDate)] };
  const primary = document.plans[0];
  if (!primary || typeof primary !== "object" || Array.isArray(primary)) return document;
  const dates = [currentDate, primary.startDate, primary.endDate,
    ...(Array.isArray(primary.entries) ? primary.entries : []).flatMap((entry) => [entry?.date, entry?.repeatUntil]),
    ...(Array.isArray(primary.rowOverrides) ? primary.rowOverrides : []).flatMap((row) => [row?.date, String(row?.rowId || "").slice(-10)]),
  ].map(supportedDate).filter(Boolean);
  const horizon = addDays(currentDate, 365);
  const startDate = dates.slice().sort()[0];
  const endDate = [...dates, horizon > "2200-12-31" ? "2200-12-31" : horizon].sort().at(-1);
  return { ...document, plans: [{ ...primary, continuous: true, balanceMode: "live",
    includeTransactions: primary.restart?.version === 1 ? primary.includeTransactions ?? true : true,
    startDate, endDate }, ...document.plans.slice(1)] };
}
