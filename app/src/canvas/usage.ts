import type { UsageReport } from "./store";

/** Compact token count: 1234 → "1.2k", 1_500_000 → "1.5M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Cumulative token thresholds for the 10 group levels (index 0 = level 1). */
const LEVEL_THRESHOLDS = [
  0, 100_000, 300_000, 900_000, 2_700_000, 8_000_000, 24_000_000, 72_000_000,
  216_000_000, 650_000_000,
];

/** Group level (1..10) by total tokens spent, plus progress to the next level. */
export function groupLevel(tokens: number): {
  level: number;
  progress: number;
  nextAt: number | null;
} {
  let level = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
    if (tokens >= LEVEL_THRESHOLDS[i]) level = i + 1;
  }
  if (level >= 10) return { level: 10, progress: 1, nextAt: null };
  const cur = LEVEL_THRESHOLDS[level - 1];
  const next = LEVEL_THRESHOLDS[level];
  const progress = Math.min(1, Math.max(0, (tokens - cur) / (next - cur)));
  return { level, progress, nextAt: next };
}

/** USD cost with adaptive precision. */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Sum a list of usage reports into a single total. */
export function sumUsage(reports: UsageReport[]): UsageReport {
  return reports.reduce<UsageReport>(
    (acc, r) => ({
      input_tokens: acc.input_tokens + r.input_tokens,
      output_tokens: acc.output_tokens + r.output_tokens,
      cache_creation_input_tokens:
        acc.cache_creation_input_tokens + r.cache_creation_input_tokens,
      cache_read_input_tokens: acc.cache_read_input_tokens + r.cache_read_input_tokens,
      total_tokens: acc.total_tokens + r.total_tokens,
      cost_usd: acc.cost_usd + r.cost_usd,
      found: acc.found || r.found,
    }),
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
      found: false,
    },
  );
}
