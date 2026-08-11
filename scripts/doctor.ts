/**
 * `npm run doctor` — report provider availability without starting the server.
 *
 * Exits 0 even when nothing is configured, so it is safe in CI. Use
 * `--strict` to exit non-zero when zero providers are usable.
 */
import { getAvailableProviders, PROVIDERS, buildModelChain, selectModel } from '../src/mastra/config/models';
import { hasAnyRates } from '../src/mastra/config/pricing';

const strict = process.argv.includes('--strict');
const availability = getAvailableProviders();
const configured = availability.filter((p) => p.configured);

console.log('\nProvider availability');
console.log('─'.repeat(78));
console.log(['provider'.padEnd(12), 'status'.padEnd(16), 'key source / reason'].join(' '));
console.log('─'.repeat(78));

for (const p of availability) {
  const status = p.configured ? 'configured' : 'not configured';
  const detail = p.configured ? p.keySource! : p.reason!;
  console.log([p.id.padEnd(12), status.padEnd(16), detail].join(' '));
}

console.log('─'.repeat(78));
console.log(`${configured.length} of ${availability.length} providers usable`);

const selection = selectModel();
if (selection) {
  console.log(`\ndefault model : ${selection.modelString}  (tier: ${selection.tier})`);
  const chain = buildModelChain();
  console.log('fallback chain:');
  chain.forEach((entry, i) => {
    console.log(`  ${i === 0 ? 'primary ' : `#${i}      `} ${entry.model}  (maxRetries: ${entry.maxRetries})`);
  });
} else {
  console.log('\ndefault model : none — no provider key present');
  console.log('Set a key from the table below, then re-run:');
  for (const id of Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]) {
    const spec = PROVIDERS[id];
    console.log(`  ${spec.apiKeyEnvVars[0].padEnd(32)} ${spec.consoleUrl}`);
  }
}

console.log(`\ntoken pricing : ${hasAnyRates() ? 'configured' : 'not configured — bench cost column shows "n/a"'}`);
console.log();

if (strict && configured.length === 0) {
  console.error('doctor --strict: no providers configured');
  process.exit(1);
}
