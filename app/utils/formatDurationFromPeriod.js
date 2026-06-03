const monthIndexByName = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11
};

function parseMonthYear(value) {
  const parts = value.trim().toLowerCase().split(/\s+/);
  if (parts.length < 2) return null;

  const monthToken = parts[0].replace(/\./g, "");
  const month = monthIndexByName[monthToken];
  const year = Number(parts[1]);

  if (month === undefined || Number.isNaN(year)) {
    return null;
  }

  return { month, year };
}

function monthStamp(dateParts) {
  return dateParts.year * 12 + dateParts.month;
}

export default function formatDurationFromPeriod(period) {
  const [startRaw, endRaw] = period.split(" - ").map((value) => value.trim());
  if (!startRaw || !endRaw) return period;

  const start = parseMonthYear(startRaw);
  if (!start) return period;

  let end;
  if (endRaw.toLowerCase() === "present") {
    const now = new Date();
    end = { month: now.getMonth(), year: now.getFullYear() };
  } else {
    end = parseMonthYear(endRaw);
  }

  if (!end) return period;

  const totalMonths = Math.max(1, monthStamp(end) - monthStamp(start));
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;

  if (years > 0 && months > 0) {
    return `${years} year${years === 1 ? "" : "s"} ${months} month${months === 1 ? "" : "s"}`;
  }

  if (years > 0) {
    return `${years} year${years === 1 ? "" : "s"}`;
  }

  return `${months} month${months === 1 ? "" : "s"}`;
}
