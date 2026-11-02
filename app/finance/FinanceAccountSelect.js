"use client";

export function financeAccountLabel(account) {
  if (!account) return "Unavailable account";
  const parts = [account.name || "Account"];
  if (account.mask) parts.push(`••${account.mask}`);
  if (account.institutionName) parts.push(account.institutionName);
  if (account.type) parts.push(String(account.type).replaceAll("_", " "));
  if (account.currency) parts.push(account.currency);
  return parts.join(" · ");
}

export default function FinanceAccountSelect({
  accounts = [],
  value,
  onChange,
  currency,
  allowNone = true,
  emptyLabel = "Unassigned",
  disabled = false,
  label,
  ...props
}) {
  const selectable = accounts.filter(
    (account) =>
      !account.isArchived &&
      !account.is_archived &&
      (!currency || account.currency === currency),
  );
  const selected = selectable.find(
    (account) => String(account.id) === String(value),
  );
  const unavailable =
    value !== null && value !== undefined && value !== "" && !selected;
  const historical = accounts.find(
    (account) => String(account.id) === String(value),
  );
  return (
    <select
      {...props}
      aria-label={props["aria-label"] || label}
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) =>
        onChange?.(event.target.value ? Number(event.target.value) : null)
      }
    >
      {allowNone && <option value="">{emptyLabel}</option>}
      {!allowNone && (
        <option value="" disabled>
          Choose an account
        </option>
      )}
      {unavailable && (
        <option value={value} disabled>
          {historical ? financeAccountLabel(historical) : "Unavailable account"}{" "}
          — choose another
        </option>
      )}
      {selectable.map((account) => (
        <option key={account.id} value={account.id}>
          {financeAccountLabel(account)}
        </option>
      ))}
    </select>
  );
}
