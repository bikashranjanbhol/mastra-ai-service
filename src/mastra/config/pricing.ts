/**
 * Token pricing for the benchmark's "est. cost" column.
 *
 * ── Why this ships EMPTY ────────────────────────────────────────────────────
 * Provider pricing changes frequently and is NOT carried in Mastra's provider
 * registry. Hard-coding rates from memory would put invented numbers in a
 * column you are going to make decisions from. So: rates are operator-supplied.
 * Until you supply them, the benchmark prints "n/a" for cost — never a guess.
 *
 * ── Supplying rates ─────────────────────────────────────────────────────────
 * Either edit DEFAULT_RATES below, or point MODEL_PRICING_FILE at a JSON file:
 *
 *   {
 *     "openai/gpt-5-mini":        { "inputPerMTok": 0.25, "outputPerMTok": 2.00 },
 *     "anthropic/claude-haiku-4-5": { "inputPerMTok": 1.00, "outputPerMTok": 5.00 }
 *   }
 *
 * Keys are full router strings (`provider/model-id`), matching what the agents
 * actually send. Values are USD per 1,000,000 tokens.
 * Source of truth is each provider's own pricing page — see README.
 */
import { readFileSync } from 'node:fs';

export interface TokenRate {
  /** USD per 1,000,000 input tokens. */
  readonly inputPerMTok: number;
  /** USD per 1,000,000 output tokens. */
  readonly outputPerMTok: number;
}

/**
 * Intentionally empty. Fill in rates you have verified against provider pricing
 * pages, keyed by full router string.
 */
export const DEFAULT_RATES: Readonly<Record<string, TokenRate>> = {};

let cache: Record<string, TokenRate> | undefined;

function loadRates(): Record<string, TokenRate> {
  if (cache) return cache;

  const merged: Record<string, TokenRate> = { ...DEFAULT_RATES };
  const file = process.env.MODEL_PRICING_FILE?.trim();

  if (file) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, TokenRate>;
      for (const [model, rate] of Object.entries(parsed)) {
        if (typeof rate?.inputPerMTok === 'number' && typeof rate?.outputPerMTok === 'number') {
          merged[model] = rate;
        }
      }
    } catch (err) {
      // Pricing is a nice-to-have; a bad file must not fail a benchmark run.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[pricing] could not read MODEL_PRICING_FILE="${file}": ${reason} — cost will show as n/a`);
    }
  }

  cache = merged;
  return merged;
}

/** Reset memoised rates (used by tests). */
export function resetPricingCache(): void {
  cache = undefined;
}

/** True when at least one rate is known. */
export function hasAnyRates(): boolean {
  return Object.keys(loadRates()).length > 0;
}

/**
 * Estimated USD cost for a call, or `undefined` when no rate is configured for
 * that model. `undefined` means "unknown" and must render as "n/a" — never 0.
 */
export function estimateCostUsd(
  modelString: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | undefined {
  const rate = loadRates()[modelString];
  if (!rate) return undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return ((inputTokens ?? 0) / 1_000_000) * rate.inputPerMTok + ((outputTokens ?? 0) / 1_000_000) * rate.outputPerMTok;
}

/** Render for the benchmark table. */
export function formatCost(cost: number | undefined): string {
  if (cost === undefined) return 'n/a';
  if (cost === 0) return '$0.0000';
  return `$${cost.toFixed(cost < 0.01 ? 6 : 4)}`;
}
