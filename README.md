# mastra-ai-service

Provider-agnostic [Mastra](https://mastra.ai) agents with a cross-provider benchmark harness.

Two agents answer questions over an internal documentation corpus and file tickets for work
that needs a human. The point of the project is that **the same agent runs against every
model provider you have a key for** — provider choice is configuration, not code.

Built against **Mastra v1** (`@mastra/core` 1.57.0, `mastra` CLI 1.23.0).

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | **≥ 22.13** | Enforced via `engines`. Developed on v22.22.2. |
| npm | ≥ 10 | Any of npm/pnpm/bun works; scripts below use npm. |
| A provider API key | at least one | Any single provider is enough to run. |

No AI SDK provider packages are installed and none should be. Models are selected with
Mastra's **model router** using `provider/model-id` strings.

---

## Setup

```bash
npm install
cp .env.example .env      # then fill in at least one provider key
npm run doctor            # shows which providers are usable
npm run dev               # Studio at http://localhost:4111
```

`npm run doctor` is the fastest way to confirm your environment before starting anything:

```
provider     status           key source / reason
openai       configured       OPENAI_API_KEY
anthropic    not configured   no key in ANTHROPIC_API_KEY
google       configured       GOOGLE_API_KEY
...
default model : openai/gpt-5-mini  (tier: fast)
fallback chain:
  primary  openai/gpt-5-mini            (maxRetries: 2)
  #1       google/gemini-2.5-flash      (maxRetries: 1)
```

---

## Environment variables

### Provider keys

Every provider is **optional**. A missing key skips that provider with a log line; the app
only hard-fails if *zero* providers are configured. Variable names below are taken from
`@mastra/core`'s own `provider-registry.json`, not from memory.

| Provider | Environment variable | Where to get a key |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| Anthropic | `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys |
| Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` *or* `GOOGLE_API_KEY` | https://aistudio.google.com/apikey |
| Groq | `GROQ_API_KEY` | https://console.groq.com/keys |
| Mistral | `MISTRAL_API_KEY` | https://console.mistral.ai/api-keys |
| OpenRouter | `OPENROUTER_API_KEY` | https://openrouter.ai/keys |

> Google is the one provider that accepts **either** of two variable names. Setting one is enough.

### Everything else

| Variable | Default | Purpose |
|---|---|---|
| `DEFAULT_PROVIDER` | first configured | Primary provider. Ignored (with a warning) if its key is missing. |
| `DEFAULT_TIER` | `fast` | `fast` \| `flagship` \| `reasoning`. Falls back to `flagship` where a provider has no reasoning model. |
| `FALLBACK_PROVIDERS` | registry order | Comma-separated provider order for the fallback chain. |
| `DATABASE_URL` | — | Set to a `postgres://` URL to switch storage to Postgres. **This is the only storage switch.** |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | — | Hosted LibSQL instead of a local file. |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `SERVICE_NAME` | `mastra-ai-service` | Tags every log line and trace. |
| `BENCH_TIER` | `fast` | Tier the benchmark exercises. |
| `BENCH_CONCURRENCY` | `3` | Providers exercised in parallel. |
| `BENCH_MAX_RETRIES` | `3` | Retry budget per task on 429/5xx. |
| `BENCH_OUT_DIR` | `./bench-results` | Where run artifacts are written. |
| `MODEL_PRICING_FILE` | — | JSON file of token rates for the cost column. |
| `MASTRA_TELEMETRY_DISABLED` | — | Set to `1` to silence Mastra CLI analytics. |

`.env` is gitignored. `.env.example` documents every variable and is safe to commit.

---

## Running

| Command | What it does |
|---|---|
| `npm run dev` | Dev server + Studio at **http://localhost:4111** |
| `npm run doctor` | Provider availability, default model, fallback chain. Add `--strict` to fail when none configured. |
| `npm run bench` | Cross-provider comparison table (see below) |
| `npm run bench:selftest` | Verifies the benchmark harness itself, no keys needed |
| `npm run smoke` | Exercises tools, storage and scorers, no keys needed |
| `npm run check:neutral` | Fails if a provider name appears outside `config/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | `mastra build` → `.mastra/output/` |
| `npm start` | Runs the built server |

### Studio

`npm run dev`, then open <http://localhost:4111>. Both agents and the workflow appear there.
To point an agent at a specific provider from Studio or the API, set `provider` and `tier`
on the request context.

### The benchmark

```bash
npm run bench                      # all configured providers, BENCH_TIER
npm run bench -- --tier=flagship   # override tier
npm run bench -- --strict          # non-zero exit if anything failed
```

Output is a comparison table plus a per-task breakdown, and a timestamped JSON file in
`bench-results/` so runs stay comparable over time.

```
provider     model                          pass/fail    latency   tok in/out   est. cost  tools  quality
openai       openai/gpt-5-mini              6/6             0.2s     2520/510         n/a      4     1.00
anthropic    anthropic/claude-haiku-4-5     0/6             0.2s     1720/340         n/a      0     0.40
google       google/gemini-2.5-flash        not configured     —            —           —      —        —
```

The task set deliberately includes **tool-calling** and **structured-output** cases, since
that is where providers diverge most. Notes on how it behaves:

- Providers with no key are reported as `not configured` — never counted as failures.
- Each request **pins a single provider** (`fallback: 'off'`). Without this the fallback
  chain would rescue a failing provider and the table would misattribute the result.
- Providers run concurrently; tasks within a provider run sequentially, so one provider's
  rate limit is not amplified. 429/5xx retries use jittered exponential backoff and honour
  `retryAfter` when present.
- **Quality** is scored by deterministic code scorers (`src/mastra/scorers/`), not an LLM
  judge — a judge would itself be a provider and would bias a cross-provider comparison.

#### The cost column

`est. cost` shows `n/a` until you supply token rates. Provider pricing is not carried in
Mastra's registry and changes often, so this project **does not ship invented rates**.
Add them in `src/mastra/config/pricing.ts`, or point `MODEL_PRICING_FILE` at:

```json
{
  "openai/gpt-5-mini": { "inputPerMTok": 0.25, "outputPerMTok": 2.00 }
}
```

---

## Project structure

```
src/
  mastra/
    index.ts             Mastra instance — registers agents, tools, workflows, scorers
    config/
      models.ts          ★ single source of truth: provider registry, availability,
                           request-time selection, fallback chain, zod env validation
      pricing.ts         operator-supplied token rates for the cost column
      storage.ts         LibSQL ⇄ Postgres selection, driven only by DATABASE_URL
      logger.ts          structured logging, tagged with provider/model
      startup.ts         boot-time env report
    agents/
      docs-agent.ts      Q&A over docs + ticket filing (tool-using)
      triage-agent.ts    structured classification
    tools/
      search-docs.ts     createTool(), deterministic retrieval
      create-ticket.ts   createTool(), persists via the store seam
    workflows/
      triage-and-file.ts search → triage → conditionally file
    scorers/index.ts     groundedness + triage-validity (code-based)
    services/
      ticket-store.ts    storage seam; LibSQL and Postgres adapters
    data/docs.ts         the documentation corpus
  bench/
    tasks.ts             fixed task set with objective graders
    runner.ts            concurrency, retries, scoring
    report.ts            table rendering + JSON artifact
scripts/                 doctor, bench, smoke, selftest, neutrality check
```

### The one rule

**No provider name appears in `agents/`, `tools/`, `workflows/`, `services/` or `data/`.**
Provider knowledge lives only in `config/`. This is enforced, not just documented:

```bash
npm run check:neutral
```

Agents receive their model from the request context:

```ts
model: ({ requestContext }) => modelChainForRequest(requestContext)
```

> Note the key is **`requestContext`**. It was named `runtimeContext` in earlier Mastra
> versions and renamed in v1 (`RuntimeContext` → `RequestContext`, now imported from
> `@mastra/core/request-context`). Code written from memory against the old name fails.

---

## Path to production

Target: **Mastra server on a VM or container** — a long-running Node process.

```bash
npm run build                     # → .mastra/output/
node .mastra/output/index.mjs     # verified to boot and serve both agents
```

### Deploying

1. Build produces a self-contained bundle in `.mastra/output/` with its own
   `package-lock.json`. Ship that directory, run `npm ci --omit=dev` beside it, start
   `index.mjs`.
2. Set `DATABASE_URL` to your Postgres instance. Nothing else changes — no agent, tool or
   workflow code references a storage backend.
3. Set `LOG_LEVEL=info` and a distinct `SERVICE_NAME` per environment. Every model log line
   already carries `provider` and `model`, so failures are attributable to a specific pair.
4. Keep `FALLBACK_PROVIDERS` populated with at least two configured providers so a single
   provider outage degrades instead of failing.

### What works locally but will break elsewhere

These are real, not hypothetical. Each is fine on a VM/container and breaks on the target noted.

| Thing | Where it breaks | Why, and what to do |
|---|---|---|
| **SQLite file storage** (`file:./mastra.db`) | Serverless (Vercel, Lambda), Cloudflare, any multi-replica deploy | The filesystem is ephemeral and per-instance; writes vanish between invocations and replicas diverge. Set `DATABASE_URL` to Postgres. This is the single most important switch before deploying anywhere but a VM. |
| **DuckDB observability store** (from the scaffold) | Serverless, Cloudflare | Writes to local disk. Currently removed from `src/mastra/index.ts` in favour of the storage exporter; do not reintroduce it on a serverless target. |
| **In-process ticket store singleton** | Multi-replica deploys | The singleton is per-process. It is only a cache over the DB, so this is safe *once on Postgres*, but a SQLite file behind it would silently fork state per replica. |
| **In-memory doc corpus** (`data/docs.ts`) | Nowhere — but it does not scale | Fine at this size and it keeps benchmarks reproducible. Once the corpus is real, move `search-docs.ts` to a vector store; nothing else changes. |
| **Agent memory** | Serverless with SQLite | Memory persists through Mastra storage. On Postgres it survives; on a local file behind serverless it does not. |
| **Long agent runs / multi-step tool loops** | Vercel and other serverless timeouts | A multi-step tool-calling turn can exceed a short function timeout. On serverless, cap `maxSteps`, stream, or move long work into a workflow with durable steps. |
| **Node built-ins** (`node:fs`, `pg`, `@libsql/client`) | Cloudflare Workers | The Workers runtime lacks parts of Node. Postgres needs an HTTP/serverless driver there. Target Workers only if you are prepared to change the storage adapters in `config/storage.ts` and `services/ticket-store.ts`. |
| **`bench-results/` writes** | Any read-only or ephemeral filesystem | The benchmark is a local/CI tool, not a server endpoint. Do not invoke it from the deployed service. |
| **Outbound network to provider APIs** | Locked-down VPCs | Egress to each provider's API host must be allowed. A blocked host surfaces as a provider-wide failure in the benchmark table — which is exactly how you will spot it. |

### Before the first deploy

```bash
npm run typecheck && npm run check:neutral && npm run smoke && npm run build
```

Then, with keys present, `npm run bench -- --strict` to confirm your chosen provider
actually passes the task set at the tier you plan to run.
