const text = (value) => String(value || "").trim();
const normalized = (value) => text(value).toLowerCase().replace(/\s+/g, " ");
const field = (row, snake, camel) => row?.[snake] ?? row?.[camel];

/** Never identify an account using its balance or a display name alone. */
export function financeAccountIdentity(row) {
  const provider = text(field(row, "external_provider", "provider"));
  const institution = text(field(row, "institution_id", "institutionId"));
  const persistent = text(
    field(row, "persistent_account_id", "persistentAccountId"),
  );
  const mask = text(field(row, "account_mask", "mask"));
  const type = normalized(field(row, "account_type", "type"));
  const name = normalized(
    field(row, "official_name", "officialName") || row?.name,
  );
  const currency = text(row?.currency).toUpperCase();
  return {
    provider,
    institution,
    persistent,
    mask,
    type,
    name,
    currency,
    persistentKey:
      provider && institution && persistent
        ? JSON.stringify([provider, institution, persistent, currency])
        : "",
    fallbackKey:
      provider && institution && mask && type && name && currency
        ? JSON.stringify([provider, institution, mask, type, name, currency])
        : "",
  };
}

/** Mask/name fallback is accepted only when it identifies at most one account per Item. */
export function financeAccountDuplicateGroups(rows) {
  const candidates = rows.filter(
    (row) => !Number(row.merged_into_account_id || 0),
  );
  const groups = [];
  const consumed = new Set();
  const byPersistent = new Map();
  for (const row of candidates) {
    const identity = financeAccountIdentity(row);
    if (!identity.persistentKey) continue;
    if (!byPersistent.has(identity.persistentKey))
      byPersistent.set(identity.persistentKey, []);
    byPersistent.get(identity.persistentKey).push(row);
  }
  for (const members of byPersistent.values()) {
    if (members.length < 2) continue;
    groups.push({ reason: "persistent_account_id", accounts: members });
    members.forEach((row) => consumed.add(Number(row.id)));
  }
  const byFallback = new Map();
  for (const row of candidates) {
    if (consumed.has(Number(row.id))) continue;
    const identity = financeAccountIdentity(row);
    if (!identity.fallbackKey) continue;
    if (!byFallback.has(identity.fallbackKey))
      byFallback.set(identity.fallbackKey, []);
    byFallback.get(identity.fallbackKey).push(row);
  }
  for (const members of byFallback.values()) {
    if (members.length < 2) continue;
    const perConnection = new Set(
      members.map((row) => String(field(row, "connection_id", "connectionId"))),
    );
    const persistent = new Set(
      members
        .map((row) => financeAccountIdentity(row).persistent)
        .filter(Boolean),
    );
    if (perConnection.size !== members.length || persistent.size > 1) continue;
    groups.push({
      reason: "institution_mask_name_type_currency",
      accounts: members,
    });
  }
  return groups.map(({ reason, accounts }) => {
    const sorted = [...accounts].sort((a, b) => Number(a.id) - Number(b.id));
    return {
      reason,
      canonicalId: Number(sorted[0].id),
      duplicateIds: sorted.slice(1).map((row) => Number(row.id)),
      accounts: sorted,
    };
  });
}

export function findFinanceAccountIdentityMatch(incoming, rows) {
  const identity = financeAccountIdentity(incoming);
  const available = rows.filter(
    (row) => !Number(row.merged_into_account_id || 0),
  );
  const exact = available.filter(
    (row) =>
      identity.persistentKey &&
      financeAccountIdentity(row).persistentKey === identity.persistentKey,
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1)
    return exact.sort((a, b) => Number(a.id) - Number(b.id))[0];
  const matching = available.filter(
    (row) =>
      identity.fallbackKey &&
      financeAccountIdentity(row).fallbackKey === identity.fallbackKey,
  );
  if (matching.length !== 1) return null;
  const previous = financeAccountIdentity(matching[0]);
  if (
    identity.persistent &&
    previous.persistent &&
    identity.persistent !== previous.persistent
  )
    return null;
  // Existing accounts within this same Item can share a mask/name; never guess.
  if (
    String(field(matching[0], "connection_id", "connectionId")) ===
    String(field(incoming, "connection_id", "connectionId"))
  )
    return null;
  return matching[0];
}

/** Explicit owner confirmation is required for pairs without machine-verifiable identity. */
export function confirmedFinanceAccountGroups(
  rows,
  pairs = [],
  automaticGroups = [],
) {
  const invalid = () => {
    throw Object.assign(
      new Error(
        "Choose valid accounts at the same institution and in the same currency for a confirmed merge.",
      ),
      { status: 400 },
    );
  };
  if (!Array.isArray(pairs) || pairs.length > 100) return invalid();
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const consumed = new Set(
    automaticGroups.flatMap((group) =>
      group.accounts.map((account) => Number(account.id)),
    ),
  );
  const groups = [];
  for (const pair of pairs) {
    if (
      !pair ||
      !Number.isSafeInteger(pair.canonicalId) ||
      !Array.isArray(pair.duplicateIds) ||
      !pair.duplicateIds.length ||
      pair.duplicateIds.length > 20
    )
      return invalid();
    const ids = [pair.canonicalId, ...pair.duplicateIds];
    if (
      ids.some(
        (id) =>
          !Number.isSafeInteger(id) ||
          id <= 0 ||
          !byId.has(id) ||
          consumed.has(id),
      ) ||
      new Set(ids).size !== ids.length
    )
      return invalid();
    const accounts = ids.map((id) => byId.get(id));
    const identities = accounts.map(financeAccountIdentity);
    const first = identities[0];
    if (
      !first.institution ||
      first.provider !== "plaid" ||
      accounts.some((account) => account.merged_into_account_id) ||
      identities.some(
        (identity) =>
          identity.provider !== first.provider ||
          identity.institution !== first.institution ||
          identity.type !== first.type ||
          identity.currency !== first.currency,
      ) ||
      new Set(identities.map((identity) => identity.persistent).filter(Boolean))
        .size > 1
    )
      return invalid();
    groups.push({
      reason: "user_confirmed_identity",
      canonicalId: pair.canonicalId,
      duplicateIds: pair.duplicateIds,
      accounts,
    });
    ids.forEach((id) => consumed.add(id));
  }
  return groups;
}

const ACCOUNT_KEYS = new Set([
  "accountId",
  "reserveAccountId",
  "sourceAccountId",
  "fromAccountId",
  "toAccountId",
  "salaryAccountId",
]);
export function remapFinancePlannerAccountIds(document, replacements) {
  const map =
    replacements instanceof Map
      ? replacements
      : new Map(
          Object.entries(replacements || {}).map(([from, to]) => [
            Number(from),
            Number(to),
          ]),
        );
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (
          ["accountOpeningBalances", "startingAccounts"].includes(key) &&
          Array.isArray(item)
        ) {
          const selected = new Map();
          for (const row of [...item].sort(
            (a, b) =>
              Number(map.has(Number(a.accountId))) -
              Number(map.has(Number(b.accountId))),
          )) {
            const remapped = visit(row);
            if (!selected.has(remapped.accountId))
              selected.set(remapped.accountId, remapped);
          }
          return [key, [...selected.values()]];
        }
        return [
          key,
          ACCOUNT_KEYS.has(key) && item != null && map.has(Number(item))
            ? map.get(Number(item))
            : visit(item),
        ];
      }),
    );
  };
  return visit(document);
}

function transactionFingerprint(row) {
  return JSON.stringify([
    String(row.transaction_date || row.date || "").slice(0, 10),
    row.kind,
    Number(row.amount).toFixed(2),
    row.currency,
    normalized(row.merchant),
    Boolean(Number(row.pending)),
  ]);
}

/** Collapse cross-Item copies as a multiset: two real identical purchases stay two. */
export function financeTransactionDuplicatePairs(rows) {
  const fingerprints = new Map();
  for (const row of rows) {
    if (
      (row.external_provider || row.provider) !== "plaid" ||
      !row.import_connection_id ||
      row.is_provider_removed
    )
      continue;
    const fingerprint = transactionFingerprint(row);
    if (!fingerprints.has(fingerprint))
      fingerprints.set(fingerprint, new Map());
    const sources = fingerprints.get(fingerprint);
    const source = String(row.import_connection_id);
    if (!sources.has(source)) sources.set(source, []);
    sources.get(source).push(row);
  }
  const pairs = [];
  for (const sources of fingerprints.values()) {
    if (sources.size < 2) continue;
    const lists = [...sources.values()].map((list) =>
      list.sort((a, b) => Number(a.id) - Number(b.id)),
    );
    lists.sort(
      (a, b) => b.length - a.length || Number(a[0].id) - Number(b[0].id),
    );
    for (const other of lists.slice(1)) {
      other.forEach((row, index) =>
        pairs.push({
          id: Number(row.id),
          canonicalId: Number(lists[0][index].id),
        }),
      );
    }
  }
  return pairs;
}
