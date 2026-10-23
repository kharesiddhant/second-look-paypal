// Run: npx tsx day1-test/facts.check.ts
// Fails loudly if CSV reading, row checks, facts, the code floor, fix checks or payout status rules break.
import assert from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCsvTable, validatePayoutRows } from '../lib/csv';
import { buildFacts, formatFacts, lineContexts, parseInvoices, suggestEmail, type Invoice } from '../lib/facts';
import { guardLine } from '../lib/guards';
import type { LineReview } from '../lib/review';

async function main() {
  const read = (f: string) => readFileSync(`day1-test/${f}`, 'utf8');
  const hist = parseCsvTable(read('history.csv')).rows; // seed rows: completed payouts
  const demo = parseInvoices(read('invoices.txt'));      // notes: n1 = PN-01 note, n2 = Jane's forwarded email
  const blind = parseCsvTable(read('blind-payout.csv'));

  // CSV reading: quoted commas and quotes, header case, validation by row.
  const q = parseCsvTable('Name,EMAIL,amount,currency,invoice,note\n"Doe, Jane",j@x.com,120.00,usd,JD-10,"said ""hi"""');
  assert.equal(q.rows[0].name, 'Doe, Jane');
  assert.equal(q.rows[0].note, 'said "hi"');
  assert.deepStrictEqual(validatePayoutRows(q.rows), []);
  assert.equal(validatePayoutRows(parseCsvTable('name,email,amount,currency,invoice\nA,not-an-email,850 USD,US,X-1').rows).length, 3);
  assert.match(validatePayoutRows(parseCsvTable('name,amount\nA,1').rows)[0], /Missing column/);

  // Line numbers are positions, even when the CSV repeats its own line numbers.
  const dupNums = parseCsvTable('line,name,email,amount,currency,invoice\n1,Jane,j@x.com,120,USD,JD-10\n1,Omar,o@x.com,8500,USD,OD-10');
  assert.deepStrictEqual(lineContexts(dupNums, [], []).map(c => c.line), [1, 2]);

  // Facts on the blind batch.
  const facts = buildFacts(blind, hist, demo.invoices, demo.notes).split('\n\n');
  assert.match(facts[0], /email vs pay-to jane\.designer/);
  assert.match(facts[0], /notes: n2$/m);                         // Jane's email is referenced, not copied
  assert.match(facts[1], /amount 8500\.00 vs 850\.00/);
  assert.match(facts[2], /duplicate: OD-09 already paid 2026-09-30/); // od-09 normalised
  assert.match(facts[3], /invoice RV-10: amount, currency, email match/);
  assert.doesNotMatch(facts[3], /duplicate|notes:/);             // "Raj" matches no unrelated note
  assert.match(facts[5], /amount 3000\.00 vs 300\.00; currency USD vs EUR/);
  assert.match(facts[6], /history: none \(first-time\)/);
  assert.match(facts[7], /notes: n1$/m);

  // Two different invoices under one ID are a conflict; an identical repeat is not.
  const od10 = demo.invoices.find(i => i.id === 'OD-10')!;
  const fake: Invoice = { ...od10, id: 'od-10', amount: '8500.00' };
  assert.match(buildFacts(blind, hist, [...demo.invoices, fake]).split('\n\n')[1], /2 different invoices share this ID/);
  assert.match(buildFacts(blind, hist, [...demo.invoices, { ...od10 }]).split('\n\n')[1], /amount 8500\.00 vs 850\.00/);

  // A payout still in flight counts as a duplicate, but not as paid history.
  const flight = [...hist, { date: '2026-10-22', name: 'Raj Video', email: 'raj.video@personal.example.com', amount: '400.00', currency: 'USD', invoice: 'RV-10', state: 'in_flight' as const }];
  const f2 = buildFacts(blind, flight, demo.invoices).split('\n\n');
  assert.match(f2[3], /RV-10 has a payout still in flight since 2026-10-22/);
  assert.match(f2[3], /history: 400\.00 USD x5, 450\.00 USD x1;/);

  // Code floor and fix checks.
  const ctx = lineContexts(blind, hist, demo.invoices, demo.notes);
  const ok = (line: number): LineReview => ({ line, verdict: 'ok', flags: [], fix: null, fix_note: null });
  const g2 = guardLine(ok(2), ctx[1]);
  assert.equal(g2.verdict, 'block');                             // AI said ok on a 10x amount
  assert.deepStrictEqual(g2.fix, { action: 'set', changes: [{ field: 'amount', value: '850.00' }] });
  assert.deepStrictEqual(guardLine(ok(3), ctx[2]).fix, { action: 'drop' }); // already paid
  assert.equal(guardLine(ok(1), ctx[0]).verdict, 'block');      // email on neither invoice nor history
  assert.deepStrictEqual(guardLine(ok(6), ctx[5]).fix,
    { action: 'set', changes: [{ field: 'amount', value: '300.00' }, { field: 'currency', value: 'EUR' }] });
  assert.equal(guardLine(ok(4), ctx[3]).verdict, 'ok');          // clean line untouched
  const flaggedAmount = guardLine({ ...ok(2), verdict: 'review', flags: [{ type: 'amount', reason: 'x', evidence: 'y' }] }, ctx[1]);
  assert.equal(flaggedAmount.verdict, 'block');                  // raised…
  assert.deepStrictEqual(flaggedAmount.flags.map(f => f.type), ['amount']); // …without a second, duplicate flag
  assert.equal(guardLine({ ...ok(8), verdict: 'review' }, ctx[7]).verdict, 'review'); // missing invoice stays review
  const made = guardLine({ line: 2, verdict: 'block', flags: [], fix: { action: 'set', changes: [{ field: 'email', value: 'attacker@evil.com' }] }, fix_note: null }, ctx[1]);
  assert.match(made.fix_note ?? '', /attacker@evil\.com is not on the invoice or in past payouts/);
  assert.ok(!JSON.stringify(made.fix).includes('attacker'));

  // Resend suggestions.
  assert.deepStrictEqual(suggestEmail({ name: 'Jane Designer', email: 'jane.payments@personal.example.com', invoice: 'JD-10' }, hist, demo.invoices),
    { email: 'jane.designer@personal.example.com', source: 'invoice JD-10' });
  assert.deepStrictEqual(suggestEmail({ name: 'Omar Dev', email: 'omar.typo@example.com', invoice: 'XX-1' }, hist, demo.invoices),
    { email: 'omar.dev@personal.example.com', source: 'past payouts' });
  assert.strictEqual(suggestEmail({ name: 'Priya Nair', email: 'priya.nopaypal@example.com', invoice: 'PN-01' }, hist, demo.invoices), null);

  // Payout status rules, on a throwaway database.
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'second-look-')), 'check.db');
  process.env.DEMO = '1'; // seeds both demo histories into the throwaway database
  const { db, applyItemUpdate, getLines, getBatch, loadHistory } = await import('../lib/db');
  db().prepare("INSERT INTO batches (id, created_at, status, summary) VALUES ('b1', '2026-10-22T00:00:00Z', 'review', '')").run();
  const addLine = db().prepare(`INSERT INTO lines (id, batch_id, line, name, email, amount, currency, invoice, verdict, flags, paypal_batch_id, send_ref, sent_at)
    VALUES (?, 'b1', ?, 'Raj Video', 'raj.video@personal.example.com', '400.00', ?, ?, 'ok', '[]', ?, ?, '2026-10-22T00:00:00Z')`);
  addLine.run(1, 1, 'USD', 'RV-10', 'PB1', 'b1-USD-1');
  addLine.run(2, 2, 'EUR', 'RV-11', null, 'b1-EUR-1'); // sent, but PayPal's answer was never seen
  const upd = (lineId: number, status: string, payoutBatchId: string, senderBatchId?: string) =>
    applyItemUpdate({ lineId, itemId: `I${lineId}`, status, error: null, payoutBatchId, senderBatchId });

  assert.equal(upd(1, 'UNCLAIMED', 'OTHER-ENV'), false);         // another environment's event is ignored
  assert.equal(upd(1, 'UNCLAIMED', 'PB1'), true);
  assert.equal(loadHistory().find(h => h.invoice === 'RV-10')?.state, 'in_flight');
  upd(1, 'RETURNED', 'PB1');
  upd(1, 'UNCLAIMED', 'PB1');                                     // a late event never undoes RETURNED
  assert.equal(getLines('b1')[0].status, 'RETURNED');
  assert.equal(loadHistory().some(h => h.invoice === 'RV-10'), false); // returned payouts are not history
  assert.equal(upd(2, 'SUCCESS', 'PB2', 'b1-EUR-1'), true);       // reconciled through its sender_batch_id
  assert.equal(getLines('b1')[1].paypal_batch_id, 'PB2');
  assert.equal(db().prepare("SELECT status FROM batches WHERE id = 'b1'").get()?.status, 'sent');

  // Big batches: facts span chunk boundaries, each chunk gets only its own notes, and finalising applies the floor.
  const { reviewInput } = await import('../lib/review');
  const { refreshChunkedReview, CHUNK } = await import('../lib/chunks');
  const bigTable = parseCsvTable(read('big-payout.csv'));
  const bigDemo = parseInvoices(read('big-invoices.txt'));
  const bigCtx = lineContexts(bigTable, loadHistory(), bigDemo.invoices, bigDemo.notes);
  assert.equal(bigCtx.length, 500);
  assert.match(formatFacts([bigCtx[117]]), /duplicate: CR-0118-09 already paid 2026-09-30/);
  const part0 = reviewInput(bigCtx.slice(0, CHUNK), bigCtx, bigDemo.notes, 'rules');
  const part1 = reviewInput(bigCtx.slice(CHUNK, 2 * CHUNK), bigCtx, bigDemo.notes, 'rules');
  assert.match(part0.content, /<notes>\nn1: --- Forwarded email/); // the scam email concerns line 7, in chunk 0
  assert.doesNotMatch(part1.content, /<notes>/);
  assert.notEqual(part0.key, part1.key);

  db().prepare("INSERT INTO batches (id, created_at, status, summary, invoices, notes) VALUES ('big', '2026-10-23T00:00:00Z', 'reviewing', '', ?, ?)")
    .run(JSON.stringify(bigDemo.invoices), JSON.stringify(bigDemo.notes));
  const addBig = db().prepare(`INSERT INTO lines (batch_id, line, name, email, amount, currency, invoice, note, verdict, flags)
    VALUES ('big', ?, ?, ?, ?, ?, ?, ?, 'review', '[]')`);
  bigCtx.slice(0, 2 * CHUNK).forEach(c => addBig.run(c.line, c.row.name, c.row.email, c.row.amount, c.row.currency, c.row.invoice, c.row.note));
  const addChunk = db().prepare("INSERT INTO review_chunks (batch_id, idx, key, status, result, started_at) VALUES ('big', ?, ?, ?, ?, ?)");
  const allOk = { summary: '', lines: Array.from({ length: CHUNK }, (_, i) => ({ line: i + 1, verdict: 'ok', flags: [], fix: null, fix_note: null })) };
  addChunk.run(0, 'k0', 'done', JSON.stringify(allOk), new Date().toISOString()); // the AI says all 50 are fine
  addChunk.run(1, 'k1', 'failed', null, new Date().toISOString());                // this chunk never answered
  const progress = await refreshChunkedReview(getBatch('big')!);
  assert.deepStrictEqual(progress, { done: 2, total: 2 });
  const big = getLines('big');
  assert.equal(getBatch('big')!.status, 'review');
  assert.equal(big[6].verdict, 'block');   // line 7: changed email, caught by the code floor despite the AI's ok
  assert.equal(big[0].verdict, 'ok');
  assert.equal(big[62 - 1].verdict, 'review'); // line 62: failed chunk, needs the owner's tick
  assert.equal(big[63 - 1].verdict, 'block');  // line 63: failed chunk, but the floor still catches the 10x amount
  assert.match(getBatch('big')!.summary, /1 part\(s\) had no AI answer/);

  // Agent draft tools (no model call): everyone = invoice senders, usual amount = invoice else last payout.
  const { Draft } = await import('../lib/agent');
  const d = new Draft(loadHistory(), demo.invoices);
  assert.deepStrictEqual(d.addInvoiceSenders(['raj video']).added, 4);         // JD-10, OD-10, LW-10, SC-01
  assert.throws(() => d.addPerson('Omar Dev'), /already in the draft/);
  assert.match(d.changeAmount('Sofia Copy', { add: '50' }, 'bonus'), /800\.00 USD/);
  assert.equal(d.lines.find(l => l.name === 'Lena Writer')?.currency, 'EUR');   // invoice currency
  const h = new Draft(loadHistory(), []);
  assert.match(h.addPerson('Omar Dev'), /850\.00 USD \(usual from last payout/);  // no invoice: last completed payout
  assert.equal(h.lines[0].email, 'omar.dev@personal.example.com');            // email from history, never typed by the agent
  assert.throws(() => h.addPerson('Omar'), /No invoice or past payout for "Omar".*Omar Dev/);
  assert.deepStrictEqual(validatePayoutRows(d.table().rows), []);

  console.log('facts check passed');
}

main();
