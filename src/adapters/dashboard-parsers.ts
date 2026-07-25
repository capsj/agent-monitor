import type { Metric, UsageWindow } from "../types.js";

export interface DashboardUsageData {
  plan?: string;
  windows: UsageWindow[];
  metrics: Metric[];
}

function linesOf(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function money(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/[$€£,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function currencyNear(lines: string[], index: number, radius = 2): number | undefined {
  if (index < 0) return undefined;
  const segment = lines.slice(Math.max(0, index - radius), index + radius + 1).join(" ");
  return money(segment.match(/[$€£]\s?[\d,.]+/)?.[0]);
}

function currencyAfter(lines: string[], index: number, radius = 4): number | undefined {
  if (index < 0) return undefined;
  return money(lines.slice(index, index + radius + 1).join(" ").match(/[$€£]\s?[\d,.]+/)?.[0]);
}

export function parseHumanDuration(value: string): number | undefined {
  const units: Array<[RegExp, number]> = [
    [/(\d+(?:\.\d+)?)\s*d(?:ays?)?\b/i, 86_400],
    [/(\d+(?:\.\d+)?)\s*h(?:ours?)?\b/i, 3_600],
    [/(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?\b/i, 60],
    [/(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b/i, 1],
  ];
  let seconds = 0;
  let matched = false;
  for (const [pattern, multiplier] of units) {
    const amount = value.match(pattern)?.[1];
    if (!amount) continue;
    seconds += Number(amount) * multiplier;
    matched = true;
  }
  return matched ? seconds : undefined;
}

function relativeReset(value: string, now: Date): string | undefined {
  const seconds = parseHumanDuration(value);
  return seconds === undefined
    ? undefined
    : new Date(now.getTime() + seconds * 1000).toISOString();
}

function calendarReset(value: string, now: Date): string | undefined {
  const months = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];
  const dayFirst = value.match(
    /^(\d{1,2})\s+([A-Za-z]{3,9})(.*)$/i,
  );
  const normalized = dayFirst
    ? `${dayFirst[2]} ${dayFirst[1]}${dayFirst[3] ?? ""}`
    : value;
  const match = normalized.match(
    /^([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(\d{4}))?(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i,
  );
  if (!match) return undefined;
  const month = months.findIndex((item) => match[1]?.toLowerCase().startsWith(item));
  if (month < 0) return undefined;
  const explicitYear = match[3] ? Number(match[3]) : undefined;
  let hour = Number(match[4] ?? 0);
  if (match[6]) {
    hour %= 12;
    if (match[6].toLowerCase() === "pm") hour += 12;
  }
  let target = new Date(
    explicitYear ?? now.getFullYear(),
    month,
    Number(match[2]),
    hour,
    Number(match[5] ?? 0),
  );
  if (!explicitYear && target.getTime() <= now.getTime()) {
    target = new Date(
      now.getFullYear() + 1,
      month,
      Number(match[2]),
      hour,
      Number(match[5] ?? 0),
    );
  }
  return target.toISOString();
}

function usageWindowNear(
  lines: string[],
  label: string,
  id: string,
  now: Date,
): UsageWindow | undefined {
  const index = lines.findIndex((line) => line.toLowerCase() === label.toLowerCase());
  if (index < 0) return undefined;
  const section = lines.slice(index, index + 7);
  const usedPercent = Number(section.join(" ").match(/(\d{1,3}(?:\.\d+)?)\s*%/)?.[1]);
  if (!Number.isFinite(usedPercent)) return undefined;
  const resetDescription = section
    .find((line) => /^resets?\s+in\s+/i.test(line))
    ?.replace(/^resets?\s+in\s+/i, "");
  const resetsAt = resetDescription ? relativeReset(resetDescription, now) : undefined;
  return {
    id,
    label,
    usedPercent,
    ...(resetDescription ? { resetDescription } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    quality: "exact",
    category: "included",
  };
}

export function parseOpenCodeDashboard(
  raw: string,
  now = new Date(),
): DashboardUsageData | undefined {
  const lines = linesOf(raw);
  const windows = [
    usageWindowNear(lines, "Rolling Usage", "rolling", now),
    usageWindowNear(lines, "Weekly Usage", "weekly", now),
    usageWindowNear(lines, "Monthly Usage", "monthly", now),
  ].filter((window): window is UsageWindow => window !== undefined);
  const balanceIndex = lines.findIndex((line) => /current balance/i.test(line));
  const balance = currencyNear(lines, balanceIndex);
  const metrics: Metric[] =
    balance === undefined
      ? []
      : [
          {
            key: "credit_balance",
            label: "Current balance",
            value: balance,
            unit: "currency",
            quality: "exact",
            category: "additional",
          },
        ];
  if (windows.length === 0 && metrics.length === 0) return undefined;
  return { plan: "Go", windows, metrics };
}

export function parseClaudeDashboard(
  raw: string,
  now = new Date(),
): DashboardUsageData | undefined {
  const lines = linesOf(raw);
  const start = lines.findIndex((line) => /^usage credits$/i.test(line));
  if (start < 0) return undefined;
  const section = lines.slice(start, start + 45);
  const joined = section.join(" ");
  const spent = money(joined.match(/([$€£]\s?[\d,.]+)\s+spent\b/i)?.[1]);
  const usedPercent = Number(joined.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*used\b/i)?.[1]);
  const limitIndex = section.findIndex((line) => /monthly spend limit/i.test(line));
  const balanceIndex = section.findIndex((line) => /current balance/i.test(line));
  const limit = currencyNear(section, limitIndex);
  const balance = currencyNear(section, balanceIndex);
  const resetDescription = section
    .find((line) => /^resets?\s+/i.test(line))
    ?.replace(/^resets?\s+/i, "");
  const resetsAt = resetDescription ? calendarReset(resetDescription, now) : undefined;
  const status = joined.match(/usage credits are\s+(on|off)\b/i)?.[1]?.toLowerCase();
  const autoReloadStatus = joined.match(/auto-reload\s+(on|off)\b/i)?.[1]?.toLowerCase();
  const promotionalIndex = section.findIndex((line) => /^promotional credit$/i.test(line));
  const promotionalBalance = currencyNear(section, promotionalIndex);
  const promotionalExpiry =
    promotionalIndex < 0
      ? undefined
      : section
          .slice(promotionalIndex, promotionalIndex + 5)
          .join(" ")
          .match(/\bexpires?\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i)?.[1];
  const metrics: Metric[] = [];
  if (spent !== undefined) {
    metrics.push({
      key: "additional_spent",
      label: "Credits spent",
      value: spent,
      unit: "currency",
      quality: "exact",
      category: "additional",
    });
  }
  if (limit !== undefined) {
    metrics.push({
      key: "additional_limit",
      label: "Monthly limit",
      value: limit,
      unit: "currency",
      quality: "exact",
      category: "additional",
    });
  }
  if (balance !== undefined) {
    metrics.push({
      key: "credit_balance",
      label: "Current balance",
      value: balance,
      unit: "currency",
      quality: "exact",
      category: "additional",
    });
  }
  if (promotionalBalance !== undefined) {
    metrics.push({
      key: "promotional_credit_balance",
      label: "Promotional credit",
      value: promotionalBalance,
      unit: "currency",
      quality: "exact",
      category: "additional",
    });
  }
  if (promotionalExpiry) {
    metrics.push({
      key: "promotional_credit_expiry",
      label: "Promotion expires",
      value: promotionalExpiry,
      unit: "text",
      quality: "exact",
      category: "additional",
    });
  }
  if (status) {
    metrics.push({
      key: "usage_credits_status",
      label: "Usage credits",
      value: status,
      unit: "text",
      quality: "exact",
      category: "additional",
    });
  }
  if (autoReloadStatus) {
    metrics.push({
      key: "auto_reload_status",
      label: "Auto-reload",
      value: autoReloadStatus,
      unit: "text",
      quality: "exact",
      category: "additional",
    });
  }
  const windows: UsageWindow[] = Number.isFinite(usedPercent)
    ? [
        {
          id: "usage_credits",
          label: "Usage credits",
          usedPercent,
          ...(resetDescription ? { resetDescription } : {}),
          ...(resetsAt ? { resetsAt } : {}),
          quality: "exact",
          category: "additional",
        },
      ]
    : [];
  if (windows.length === 0 && metrics.length === 0) return undefined;
  return { windows, metrics };
}

export function parseCursorDashboard(
  raw: string,
  now = new Date(),
): DashboardUsageData | undefined {
  const lines = linesOf(raw);
  const joined = lines.join(" ");
  const plan = joined.match(/\b(Pro Plus|Pro\+|Pro|Ultra|Hobby|Business)\b/i)?.[1];
  const planResetDescription =
    joined.match(
      /usage limits?\s+resets?\s+on\s+(\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{4})?)/i,
    )?.[1] ??
    joined.match(
      /usage limits?\s+resets?\s+on\s+([A-Za-z]{3,9}\s+\d{1,2}(?:,\s*\d{4})?)/i,
    )?.[1];
  const planResetsAt = planResetDescription
    ? calendarReset(planResetDescription, now)
    : undefined;
  const modelWindow = (
    id: string,
    labelPattern: RegExp,
    label: string,
  ): UsageWindow | undefined => {
    const index = lines.findIndex((line) => labelPattern.test(line));
    if (index < 0) return undefined;
    const usedPercent = Number(
      lines
        .slice(index, index + 4)
        .join(" ")
        .match(/(\d{1,3}(?:\.\d+)?)\s*%\s*used/i)?.[1],
    );
    if (!Number.isFinite(usedPercent)) return undefined;
    return {
      id,
      label,
      usedPercent,
      ...(planResetDescription ? { resetDescription: planResetDescription } : {}),
      ...(planResetsAt ? { resetsAt: planResetsAt } : {}),
      quality: "exact",
      category: "included",
    };
  };
  const modelWindows = [
    modelWindow("monthly_cursor_models", /^cursor models\b/i, "Cursor Models"),
    modelWindow("monthly_other_models", /^other models\b/i, "Other Models"),
  ].filter((window): window is UsageWindow => window !== undefined);
  const includedIndex = lines.findIndex((line) => /included usage/i.test(line));
  const includedSection =
    includedIndex < 0 ? "" : lines.slice(includedIndex, includedIndex + 10).join(" ");
  const explicitPercent = Number(
    includedSection.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*used/i)?.[1],
  );
  const amounts = includedSection.match(
    /[$€£]\s?([\d,.]+)\s*(?:\/|of)\s*[$€£]\s?([\d,.]+)/i,
  );
  const used = amounts ? money(amounts[1]) : undefined;
  const limit = amounts ? money(amounts[2]) : undefined;
  const usedPercent =
    Number.isFinite(explicitPercent)
      ? explicitPercent
      : used !== undefined && limit !== undefined && limit > 0
        ? (used / limit) * 100
        : undefined;
  const resetDescription = includedSection
    .match(/(?:resets?|renews?)\s+(?:on\s+)?([A-Za-z]{3,9}\s+\d{1,2}(?:,\s*\d{4})?)/i)?.[1];
  const resetsAt = resetDescription ? calendarReset(resetDescription, now) : undefined;
  const legacyWindows: UsageWindow[] =
    usedPercent === undefined
      ? []
      : [
          {
            id: "included",
            label: "Plan allowance",
            usedPercent,
            ...(limit !== undefined ? { limit } : {}),
            ...(resetDescription ? { resetDescription } : {}),
            ...(resetsAt ? { resetsAt } : {}),
            quality: amounts && !Number.isFinite(explicitPercent) ? "estimated" : "exact",
            category: "included",
          },
        ];
  const windows = modelWindows.length > 0 ? modelWindows : legacyWindows;
  const spendingIndex = lines.findIndex((line) => /^on-demand spending$/i.test(line));
  const onDemandIndex =
    spendingIndex >= 0
      ? spendingIndex
      : lines.findIndex((line) => /on-demand|usage-based/i.test(line));
  const spent = currencyAfter(lines, onDemandIndex, 4);
  const onDemandStatus =
    onDemandIndex < 0
      ? undefined
      : lines
          .slice(onDemandIndex + 1, onDemandIndex + 4)
          .join(" ")
          .match(/\b(disabled|enabled)\b/i)?.[1]
          ?.toLowerCase();
  const metrics: Metric[] = [];
  if (spent !== undefined) {
    metrics.push({
      key: "additional_spent",
      label: "On-demand usage",
      value: spent,
      unit: "currency",
      quality: "exact",
      category: "additional",
    });
  }
  if (onDemandStatus) {
    metrics.push({
      key: "on_demand_status",
      label: "On-demand spending",
      value: onDemandStatus,
      unit: "text",
      quality: "exact",
      category: "additional",
    });
  }
  if (windows.length === 0 && metrics.length === 0 && !plan) return undefined;
  return { ...(plan ? { plan } : {}), windows, metrics };
}
