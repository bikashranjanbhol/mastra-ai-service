/**
 * `npm run check:neutral`
 *
 * Enforces the core invariant: no provider name may appear in agents/, tools/,
 * workflows/, services/ or data/. Provider knowledge lives only in config/.
 *
 * Exits non-zero on violation so it can gate CI.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const GUARDED_DIRS = ['src/mastra/agents', 'src/mastra/tools', 'src/mastra/workflows', 'src/mastra/services', 'src/mastra/data'];

/** Provider names and vendor-specific model families that must not leak. */
const FORBIDDEN = [
  'openai',
  'anthropic',
  'claude',
  'gpt-',
  'google',
  'gemini',
  'groq',
  'mistral',
  'openrouter',
  'llama',
  'deepseek',
  '@ai-sdk',
];

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  term: string;
  text: string;
}

const violations: Violation[] = [];

for (const dir of GUARDED_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      const lower = text.toLowerCase();
      for (const term of FORBIDDEN) {
        if (lower.includes(term)) {
          violations.push({ file: relative(ROOT, file), line: i + 1, term, text: text.trim() });
        }
      }
    });
  }
}

if (violations.length === 0) {
  console.log(`provider-neutrality: OK — no provider names in ${GUARDED_DIRS.join(', ')}`);
  process.exit(0);
}

console.error(`provider-neutrality: ${violations.length} violation(s)\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  "${v.term}"`);
  console.error(`    ${v.text.slice(0, 120)}`);
}
console.error('\nProvider knowledge belongs in src/mastra/config/ only.');
process.exit(1);
