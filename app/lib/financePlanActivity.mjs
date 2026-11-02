const DAY_MS = 86_400_000;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function calendarDate(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < "1900-01-01" ||
    value > "2200-12-31"
  ) {
    throw invalid(`${label} must be a valid date between 1900 and 2200.`);
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value
  ) {
    throw invalid(`${label} must be a valid date between 1900 and 2200.`);
  }
  return timestamp;
}

/** The same inclusive date range allowed by a budget plan, independent of the overview window. */
export function financePlanActivityRange({ startDate, endDate } = {}) {
  const start = calendarDate(startDate, "Plan start date");
  const end = calendarDate(endDate, "Plan end date");
  if (end < start || (end - start) / DAY_MS > 731) {
    throw invalid(
      "Plan dates must be in order and no more than two years apart.",
    );
  }
  return { from: startDate, to: endDate };
}
