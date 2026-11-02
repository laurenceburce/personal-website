import assert from "node:assert/strict";
import test from "node:test";
import { financePlanActivityRange } from "../app/lib/financePlanActivity.mjs";

test("plan activity accepts the complete chosen range rather than an overview month window", () => {
  assert.deepEqual(
    financePlanActivityRange({
      startDate: "2025-01-01",
      endDate: "2026-11-30",
    }),
    { from: "2025-01-01", to: "2026-11-30" },
  );
  assert.deepEqual(
    financePlanActivityRange({
      startDate: "2026-11-02",
      endDate: "2026-11-02",
    }),
    { from: "2026-11-02", to: "2026-11-02" },
  );
});

test("plan activity rejects missing, impossible and out-of-bounds calendar dates", () => {
  for (const value of [
    undefined,
    null,
    "",
    "2026-02-29",
    "2026-11-31",
    "2026-13-01",
    "2026-1-1",
    "1899-12-31",
    "2201-01-01",
    20261102,
  ]) {
    assert.throws(
      () =>
        financePlanActivityRange({ startDate: value, endDate: "2026-11-30" }),
      (error) => error.status === 400,
    );
    assert.throws(
      () =>
        financePlanActivityRange({ startDate: "2026-11-01", endDate: value }),
      (error) => error.status === 400,
    );
  }
});

test("plan activity allows leap dates and enforces the same two-year range cap as plans", () => {
  assert.deepEqual(
    financePlanActivityRange({
      startDate: "2028-02-29",
      endDate: "2030-03-01",
    }),
    { from: "2028-02-29", to: "2030-03-01" },
  );
  assert.throws(
    () =>
      financePlanActivityRange({
        startDate: "2026-11-02",
        endDate: "2026-11-01",
      }),
    /in order/,
  );
  assert.throws(
    () =>
      financePlanActivityRange({
        startDate: "2026-11-02",
        endDate: "2028-11-03",
      }),
    /two years/,
  );
});
