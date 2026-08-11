/**
 * Provider + model registry — the SINGLE SOURCE OF TRUTH for model selection.
 *
 * ── Invariants this file exists to protect ──────────────────────────────────
 *  1. No provider name appears anywhere in agents/, tools/, or workflows/.
 *     `grep -ri openai src/mastra/agents src/mastra/tools src/mastra/workflows`
 *     must return nothing. There is a test for this: `npm run check:neutral`.
 *  2. `model` is always a STRING in Mastra's model-router format
 *     `provider/model-id` — a SLASH, never a colon. We never install or import
 *     an AI-SDK provider package and never pass a provider object.
 *  3. A missing API key SKIPS that provider with a log line. It never throws,
 *     never crashes the dev server, never aborts a benchmark run.
 *
 * ── Grounding ───────────────────────────────────────────────────────────────
 * Provider ids, API-key env var names and model ids below were read out of
 * `@mastra/core/dist/provider-registry.json` at v1.57.0 — not from memory.
 * Note google accepts EITHER of two env var names, and gateway providers
 * (openrouter, groq) have multi-segment model ids, so a full router string can
 * be three segments: `openrouter/anthropic/claude-sonnet-5`.
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export const PROVIDER_IDS = ['openai', 'anthropic', 'google', 'groq', 'mistral', 'openrouter'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const MODEL_TIERS = ['fast', 'flagship', 'reasoning'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface ProviderSpec {
  readonly id: ProviderId;
  readonly label: string;
  /**
   * Accepted API-key env var names in priority order. Google is the reason this
   * is a list rather than a string.
   */
  readonly apiKeyEnvVars: readonly [string, ...string[]];
  readonly consoleUrl: string;
  /**
   * Model ids WITHOUT the provider prefix. `fast` and `flagship` are required;
   * `reasoning` is present only where the provider actually ships a distinct
   * reasoning-tier model. We do not invent one to fill the slot.
   */
  readonly models: {
    readonly fast: string;
    readonly flagship: string;
    readonly reasoning?: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export const PROVIDERS: Readonly<Record<ProviderId, ProviderSpec>> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    apiKeyEnvVars: ['OPENAI_API_KEY'],
    consoleUrl: 'https://platform.openai.com/api-keys',
    models: { fast: 'gpt-5-mini', flagship: 'gpt-5', reasoning: 'o4-mini' },
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    apiKeyEnvVars: ['ANTHROPIC_API_KEY'],
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    models: { fast: 'claude-haiku-4-5', flagship: 'claude-sonnet-5', reasoning: 'claude-opus-5' },
  },
  google: {
    id: 'google',
    label: 'Google Gemini',
    // Mastra's registry lists BOTH names for this provider.
    apiKeyEnvVars: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
    consoleUrl: 'https://aistudio.google.com/apikey',
    // No stable (non-preview) distinct reasoning tier at time of writing.
    models: { fast: 'gemini-2.5-flash', flagship: 'gemini-2.5-pro' },
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    apiKeyEnvVars: ['GROQ_API_KEY'],
    consoleUrl: 'https://console.groq.com/keys',
    models: { fast: 'llama-3.1-8b-instant', flagship: 'llama-3.3-70b-versatile' },
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    apiKeyEnvVars: ['MISTRAL_API_KEY'],
    consoleUrl: 'https://console.mistral.ai/api-keys',
    models: { fast: 'ministral-8b-latest', flagship: 'mistral-large-latest', reasoning: 'magistral-medium-latest' },
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    apiKeyEnvVars: ['OPENROUTER_API_KEY'],
    consoleUrl: 'https://openrouter.ai/keys',
    // Gateway provider: model ids are themselves `vendor/model`.
    models: {
      fast: 'deepseek/deepseek-chat-v3.1',
      flagship: 'anthropic/claude-sonnet-5',
      reasoning: 'deepseek/deepseek-r1',
    },
  },
};

/** Order used for defaults and for building fallback chains. */
export const DEFAULT_PROVIDER_ORDER: readonly ProviderId[] = [
  'openai',
  'anthropic',
  'google',
  'groq',
  'mistral',
  'openrouter',
];

// ─────────────────────────────────────────────────────────────────────────────
// Router string construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a Mastra model-router string: `provider/model-id`.
 * Always a slash. Never a colon. Never a provider object.
 */
export function toModelString(provider: ProviderId, tier: ModelTier = 'fast'): string {
  const spec = PROVIDERS[provider];
  const id = spec.models[tier] ?? spec.models.flagship;
  return `${provider}/${id}`;
}

/** Does this provider actually ship a model for this tier? */
export function hasTier(provider: ProviderId, tier: ModelTier): boolean {
  return Boolean(PROVIDERS[provider].models[tier]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Availability
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderAvailability {
  readonly id: ProviderId;
  readonly label: string;
  readonly configured: boolean;
  /** Which env var supplied the key (google can use either). */
  readonly keySource?: string;
  /** Human-readable reason when not configured. */
  readonly reason?: string;
}

/** Returns the first env var that holds a non-empty value. */
function resolveKeySource(spec: ProviderSpec, env: NodeJS.ProcessEnv): string | undefined {
  return spec.apiKeyEnvVars.find((name) => {
    const v = env[name];
    return typeof v === 'string' && v.trim().length > 0;
  });
}

/**
 * Inspect the environment and report which providers are usable.
 *
 * This NEVER throws. Callers decide what to do with an empty list; the startup
 * validator is the only place that treats "zero providers" as fatal.
 */
export function getAvailableProviders(env: NodeJS.ProcessEnv = process.env): ProviderAvailability[] {
  return DEFAULT_PROVIDER_ORDER.map((id) => {
    const spec = PROVIDERS[id];
    const keySource = resolveKeySource(spec, env);
    return keySource
      ? { id, label: spec.label, configured: true, keySource }
      : {
          id,
          label: spec.label,
          configured: false,
          reason: `no key in ${spec.apiKeyEnvVars.join(' or ')}`,
        };
  });
}

/** Just the ids that are usable, in preference order. */
export function configuredProviderIds(env: NodeJS.ProcessEnv = process.env): ProviderId[] {
  return getAvailableProviders(env)
    .filter((p) => p.configured)
    .map((p) => p.id);
}

export function isProviderConfigured(id: ProviderId, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(resolveKeySource(PROVIDERS[id], env));
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup validation
// ─────────────────────────────────────────────────────────────────────────────

const providerIdSchema = z.enum(PROVIDER_IDS);
const tierSchema = z.enum(MODEL_TIERS);

/**
 * Every provider key is OPTIONAL — that is the whole point. Only the shape of
 * the non-key settings is constrained here.
 */
export const envSchema = z.object({
  DEFAULT_PROVIDER: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(providerIdSchema.optional()),
  DEFAULT_TIER: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(tierSchema.optional()),
  FALLBACK_PROVIDERS: z.string().trim().optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).optional(),
  SERVICE_NAME: z.string().trim().min(1).optional(),
  DATABASE_URL: z.string().trim().optional(),
});

export type ValidatedEnv = z.infer<typeof envSchema>;

export interface EnvValidationResult {
  readonly env: ValidatedEnv;
  readonly availability: ProviderAvailability[];
  readonly warnings: string[];
}

export class NoProvidersConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoProvidersConfiguredError';
  }
}

/**
 * Validate env at startup.
 *
 *  - Missing optional provider keys  → warning, provider skipped.
 *  - Malformed DEFAULT_PROVIDER/TIER → warning, falls back to auto-selection.
 *  - ZERO providers configured       → throws NoProvidersConfiguredError.
 *
 * `allowZeroProviders` exists so tooling (the benchmark, CI smoke checks) can
 * introspect an unconfigured environment and report cleanly instead of dying.
 */
export function validateEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { allowZeroProviders?: boolean } = {},
): EnvValidationResult {
  const warnings: string[] = [];

  const parsed = envSchema.safeParse(env);
  let validated: ValidatedEnv;
  if (parsed.success) {
    validated = parsed.data;
  } else {
    // Never fatal: report and continue with auto-selection.
    for (const issue of parsed.error.issues) {
      warnings.push(`env ${issue.path.join('.') || '(root)'}: ${issue.message} — ignoring, using defaults`);
    }
    validated = {};
  }

  const availability = getAvailableProviders(env);
  for (const p of availability) {
    if (!p.configured) warnings.push(`provider "${p.id}" skipped — ${p.reason}`);
  }

  const configured = availability.filter((p) => p.configured);
  if (configured.length === 0 && !opts.allowZeroProviders) {
    const names = DEFAULT_PROVIDER_ORDER.map((id) => PROVIDERS[id].apiKeyEnvVars[0]).join(', ');
    throw new NoProvidersConfiguredError(
      `No model providers are configured. Set at least one of: ${names}. ` +
        `Copy .env.example to .env and fill in a key.`,
    );
  }

  if (validated.DEFAULT_PROVIDER && !isProviderConfigured(validated.DEFAULT_PROVIDER, env)) {
    warnings.push(
      `DEFAULT_PROVIDER="${validated.DEFAULT_PROVIDER}" has no API key — falling back to first configured provider`,
    );
  }

  return { env: validated, availability, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Request-time model resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shape Mastra accepts for a fallback chain entry (`ModelWithRetries`).
 * Declared structurally so this file does not depend on an internal export path.
 */
export interface ModelChainEntry {
  id?: string;
  model: string;
  maxRetries?: number;
  enabled?: boolean;
}

export interface ModelSelection {
  readonly provider: ProviderId;
  readonly tier: ModelTier;
  readonly modelString: string;
}

/** Provider preference order, honouring FALLBACK_PROVIDERS when set. */
export function providerPreferenceOrder(env: NodeJS.ProcessEnv = process.env): ProviderId[] {
  const raw = env.FALLBACK_PROVIDERS?.trim();
  if (!raw) return [...DEFAULT_PROVIDER_ORDER];

  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s): s is ProviderId => (PROVIDER_IDS as readonly string[]).includes(s));

  // Anything not named explicitly still trails the list, so a typo degrades
  // rather than silently removing providers.
  const rest = DEFAULT_PROVIDER_ORDER.filter((id) => !requested.includes(id));
  return [...requested, ...rest];
}

/**
 * Pick the primary provider/tier for a request.
 *
 * Precedence: explicit override → DEFAULT_PROVIDER env → first configured.
 * Returns undefined only when nothing at all is configured.
 */
export function selectModel(
  override: { provider?: ProviderId; tier?: ModelTier } = {},
  env: NodeJS.ProcessEnv = process.env,
): ModelSelection | undefined {
  const envTier = env.DEFAULT_TIER?.trim();
  const tier: ModelTier =
    override.tier ??
    (envTier && (MODEL_TIERS as readonly string[]).includes(envTier) ? (envTier as ModelTier) : 'fast');

  const order = providerPreferenceOrder(env);
  const candidates: ProviderId[] = [];

  if (override.provider) candidates.push(override.provider);
  const envDefault = env.DEFAULT_PROVIDER?.trim();
  if (envDefault && (PROVIDER_IDS as readonly string[]).includes(envDefault)) {
    candidates.push(envDefault as ProviderId);
  }
  candidates.push(...order);

  for (const id of candidates) {
    if (!isProviderConfigured(id, env)) continue;
    const effectiveTier: ModelTier = hasTier(id, tier) ? tier : 'flagship';
    return { provider: id, tier: effectiveTier, modelString: toModelString(id, effectiveTier) };
  }
  return undefined;
}

/**
 * Build a full fallback chain: the selected model first, then every OTHER
 * configured provider at the same tier. A provider outage degrades to the next
 * provider instead of failing the request.
 *
 * Returns [] when nothing is configured — callers surface that as a clear error
 * rather than this function throwing during module import.
 */
export function buildModelChain(
  override: { provider?: ProviderId; tier?: ModelTier } = {},
  env: NodeJS.ProcessEnv = process.env,
): ModelChainEntry[] {
  const primary = selectModel(override, env);
  if (!primary) return [];

  const tier = primary.tier;
  const ordered = [primary.provider, ...providerPreferenceOrder(env).filter((id) => id !== primary.provider)];

  return ordered
    .filter((id) => isProviderConfigured(id, env))
    .map((id, index) => {
      const effectiveTier: ModelTier = hasTier(id, tier) ? tier : 'flagship';
      return {
        id: `${id}-${effectiveTier}`,
        model: toModelString(id, effectiveTier),
        // Primary gets a slightly larger retry budget; fallbacks fail over fast.
        maxRetries: index === 0 ? 2 : 1,
        enabled: true,
      };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Request-context integration
// ─────────────────────────────────────────────────────────────────────────────

/** Request-context keys agents honour for per-request model routing. */
export const MODEL_CONTEXT_KEYS = { provider: 'provider', tier: 'tier' } as const;

/**
 * Minimal structural view of Mastra's `RequestContext`.
 *
 * NOTE: this object was named `runtimeContext` in earlier Mastra versions and
 * is `requestContext` as of v1 — the dynamic-argument type is
 * `DynamicArgument<T> = T | (({ requestContext, mastra }) => T)`.
 */
export interface ContextReader {
  get(key: string): unknown;
}

function readOverride<T extends string>(
  ctx: ContextReader | undefined,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const raw = ctx?.get(key);
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

/**
 * Resolve the model chain for a single request.
 *
 * This is what agents pass as their `model`, so the SAME agent can be pointed
 * at any provider by setting `provider` / `tier` on the request context.
 * Throws only at request time (never at import time) when nothing is configured.
 */
export function modelChainForRequest(requestContext?: ContextReader): ModelChainEntry[] {
  const chain = buildModelChain({
    provider: readOverride(requestContext, MODEL_CONTEXT_KEYS.provider, PROVIDER_IDS),
    tier: readOverride(requestContext, MODEL_CONTEXT_KEYS.tier, MODEL_TIERS),
  });

  if (chain.length === 0) {
    const names = DEFAULT_PROVIDER_ORDER.map((id) => PROVIDERS[id].apiKeyEnvVars[0]).join(', ');
    throw new NoProvidersConfiguredError(
      `Cannot resolve a model: no provider API key is set. Set one of: ${names}.`,
    );
  }
  return chain;
}
