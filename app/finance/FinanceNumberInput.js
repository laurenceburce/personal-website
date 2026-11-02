"use client";

import { useEffect, useRef } from "react";

function stepPrecision(step) {
  const text = String(step).toLowerCase();
  const [coefficient, exponent = "0"] = text.split("e");
  return Math.max(
    0,
    (coefficient.split(".")[1]?.length || 0) - Number(exponent),
  );
}

export function financeNumberError(
  value,
  { min, max, step = "0.01", required } = {},
) {
  const raw = String(value ?? "").trim();
  if (!raw) return required ? "Enter a value." : "";
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw))
    return "Enter a valid number.";
  const number = Number(raw);
  if (!Number.isFinite(number)) return "Enter a valid number.";
  if (min !== undefined && min !== "" && number < Number(min))
    return `Enter a value of at least ${min}.`;
  if (max !== undefined && max !== "" && number > Number(max))
    return `Enter a value no greater than ${max}.`;
  if (step !== "any" && Number(step) > 0) {
    const precision = stepPrecision(step);
    if ((raw.split(".")[1]?.length || 0) > precision)
      return precision === 0
        ? "Enter a whole number."
        : `Use no more than ${precision} decimal places.`;
    const base = min !== undefined && min !== "" ? Number(min) : 0;
    const scale = 10 ** Math.max(precision, stepPrecision(base));
    const units = Math.round(number * scale) - Math.round(base * scale);
    const stepUnits = Math.round(Number(step) * scale);
    // Integer cents avoid false step failures for a large negative minimum,
    // such as a signed account balance with min=-999999999.
    const increments = units / stepUnits;
    const tolerance = Number.isSafeInteger(units)
      ? 0.0000001
      : Number.EPSILON * Math.max(1, Math.abs(increments)) * 4;
    if (Math.abs(increments - Math.round(increments)) > tolerance)
      return `Use increments of ${step}.`;
  }
  return "";
}

export function normalizeFinanceNumberPaste(value) {
  const text = String(value).trim();
  // Only remove grouping and currency symbols from unambiguous money values.
  // Leave malformed grouping or mixed text for the user to correct.
  const match = text.match(
    /^([+-]?)\s*[$₱]?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)$/,
  );
  return match ? `${match[1]}${match[2].replaceAll(",", "")}` : null;
}

export function isFinanceInputComposition(event) {
  return Boolean(
    event.isComposing ||
    event.nativeEvent?.isComposing ||
    event.keyCode === 229,
  );
}

/** Keep the editing text intact; native form validation runs before saving. */
export default function FinanceNumberInput({
  value,
  min,
  max,
  step = "0.01",
  required,
  disabled,
  inputMode,
  onChange,
  onBlur,
  onKeyDown,
  onPaste,
  ref: forwardedRef,
  type: _type,
  ...props
}) {
  const input = useRef(null);
  const constraints = { min, max, step, required };
  const validate = (element) =>
    element?.setCustomValidity?.(
      disabled ? "" : financeNumberError(element.value, constraints),
    );

  useEffect(() => {
    validate(input.current);
  }, [value, min, max, step, required, disabled]);

  return (
    <input
      {...props}
      ref={(element) => {
        input.current = element;
        if (typeof forwardedRef === "function") forwardedRef(element);
        else if (forwardedRef) forwardedRef.current = element;
      }}
      type="text"
      inputMode={inputMode || (Number(step) === 1 ? "numeric" : "decimal")}
      value={value ?? ""}
      min={min}
      max={max}
      step={step}
      required={required}
      disabled={disabled}
      onChange={(event) => {
        validate(event.currentTarget || event.target);
        onChange?.(event);
      }}
      onBlur={(event) => {
        validate(event.currentTarget || event.target);
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === "Enter" && !isFinanceInputComposition(event))
          event.preventDefault();
      }}
      onPaste={(event) => {
        onPaste?.(event);
        if (event.defaultPrevented) return;
        const pasted = event.clipboardData?.getData("text");
        if (!pasted) return;
        const normalized = normalizeFinanceNumberPaste(pasted);
        if (normalized === null || normalized === pasted) return;
        const element = event.currentTarget || event.target;
        if (typeof element.setRangeText !== "function") return;
        event.preventDefault();
        element.setRangeText(
          normalized,
          element.selectionStart ?? 0,
          element.selectionEnd ?? element.value.length,
          "end",
        );
        validate(element);
        // The parent retains this exact text just as it does for a typed edit.
        onChange?.(event);
      }}
    />
  );
}
