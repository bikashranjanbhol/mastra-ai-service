/**
 * `npm run smoke` — exercise everything that does NOT require a provider key.
 *
 * Covers the deterministic half of the system: documentation search, ticket
 * persistence through the storage seam, and both quality scorers. Useful as a
 * CI gate and as a first check after cloning, before any key is configured.
 */
import { searchDocsTool } from '../src/mastra/tools/search-docs';
import { createTicketTool } from '../src/mastra/tools/create-ticket';
import { getTicketStore } from '../src/mastra/services/ticket-store';
import { resolveStorageTarget } from '../src/mastra/config/storage';
import { answerGroundednessScorer, triageValidityScorer } from '../src/mastra/scorers';

function heading(text: string) {
  console.log(`\n${text}\n${'─'.repeat(text.length)}`);
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

// ── 1. Documentation search ──────────────────────────────────────────────────
heading('1. search_docs tool');
const search = (await searchDocsTool.execute!({ query: 'how much can I expense for meals', limit: 3 }, {} as never)) as {
  matched: number;
  results: Array<{ id: string; section: string; score: number }>;
};
console.log(`  matched ${search.matched} passages, top ${search.results.length}:`);
for (const r of search.results) console.log(`    ${r.id.padEnd(16)} ${r.section.padEnd(24)} score ${r.score}`);
check('returns the expense passage first', search.results[0]?.id === 'expenses-001', search.results[0]?.id);

const noMatch = (await searchDocsTool.execute!({ query: 'zzzz nonexistent topic', limit: 3 }, {} as never)) as {
  matched: number;
};
check('unmatched query returns empty rather than throwing', noMatch.matched === 0);

// ── 2. Ticket persistence ────────────────────────────────────────────────────
heading('2. create_ticket tool + storage seam');
const target = resolveStorageTarget();
console.log(`  backend: ${target.backend} (${target.describe})`);

const created = (await createTicketTool.execute!(
  {
    title: 'Smoke test ticket',
    body: 'Created by npm run smoke to verify the storage seam.',
    severity: 'sev3',
    team: 'platform',
    sourceDocIds: ['incident-001'],
  },
  {} as never,
)) as { id: string };
console.log(`  created ${created.id}`);

const fetched = await getTicketStore().get(created.id);
check('ticket round-trips through storage', fetched?.id === created.id);
check('array field survives serialisation', fetched?.sourceDocIds[0] === 'incident-001', String(fetched?.sourceDocIds));

// ── 3. Scorers ───────────────────────────────────────────────────────────────
heading('3. answer-groundedness scorer');
const grounded = await answerGroundednessScorer.run({
  input: { retrievedDocIds: ['expenses-001'], expectedDocIds: ['expenses-001'] },
  output: { text: 'Meals are reimbursed up to 75 USD per day (expenses-001).' },
});
console.log(`  grounded answer   score ${grounded.score} — ${grounded.reason}`);
check('well-cited answer scores 1', grounded.score === 1);

const fabricated = await answerGroundednessScorer.run({
  input: { retrievedDocIds: ['expenses-001'], expectedDocIds: ['expenses-001'] },
  output: { text: 'Meals are reimbursed up to 500 USD per day (security-002).' },
});
console.log(`  fabricated cite   score ${fabricated.score} — ${fabricated.reason}`);
check('citing a non-retrieved passage scores 0', fabricated.score === 0);

const uncited = await answerGroundednessScorer.run({
  input: { retrievedDocIds: ['expenses-001'], expectedDocIds: ['expenses-001'] },
  output: { text: 'Meals are reimbursed up to 75 USD per day.' },
});
console.log(`  uncited answer    score ${uncited.score} — ${uncited.reason}`);
check('uncited answer is penalised but not zero', uncited.score > 0 && uncited.score < 1);

heading('4. triage-validity scorer');
const validTriage = await triageValidityScorer.run({
  input: { expectedSeverity: 'sev3', expectedTeam: 'finance', expectedNeedsHuman: false },
  output: { summary: 'Asks about meal limits', severity: 'sev3', team: 'finance', needsHuman: false, topics: ['expenses'] },
});
console.log(`  valid record      score ${validTriage.score} — ${validTriage.reason}`);
check('valid matching record scores 1', validTriage.score === 1);

const malformed = await triageValidityScorer.run({
  input: { expectedSeverity: 'sev3' },
  output: { summary: '', severity: 'critical', team: 'nonexistent-team', needsHuman: 'yes', topics: [] },
});
console.log(`  malformed record  score ${malformed.score} — ${malformed.reason}`);
check('malformed record scores low', malformed.score < 0.3);

// ── Result ───────────────────────────────────────────────────────────────────
heading('Result');
if (failures.length === 0) {
  console.log('  all checks passed\n');
  await getTicketStore().close();
  process.exit(0);
}
console.log(`  ${failures.length} failed: ${failures.join(', ')}\n`);
await getTicketStore().close();
process.exit(1);
