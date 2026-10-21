// Run: npx tsx day1-test/facts.check.ts  (fails loudly if the fact builder breaks)
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { buildFacts } from '../lib/facts';
import { parseCsv } from '../lib/csv';

const read = (f: string) => readFileSync(`day1-test/${f}`, 'utf8');
const facts = buildFacts(read('blind-payout.csv'), parseCsv(read('history.csv')), read('invoices.txt')).split('\n\n');

assert.match(facts[0], /email vs pay-to jane\.designer/);
assert.match(facts[0], /note: .*New payment details/);
assert.match(facts[1], /amount 8500\.00 vs 850\.00/);
assert.match(facts[2], /duplicate: OD-09 already paid 2026-09-30/); // od-09 normalised
assert.match(facts[3], /invoice RV-10: amount, currency, email match/);
assert.doesNotMatch(facts[3], /duplicate/);
assert.match(facts[5], /amount 3000\.00 vs 300\.00; currency USD vs EUR/);
assert.match(facts[6], /history: none \(first-time\)/);
assert.match(facts[7], /note: \(No invoice received for PN-01\.\)/);
assert.doesNotMatch(facts[3], /note:/); // Raj gets no unrelated notes
console.log('facts check passed');
