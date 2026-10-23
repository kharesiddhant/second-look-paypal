// Checks code applies on top of the AI's review. Both are owner's rules:
// 1. A floor: some facts can never pass as ok or review, whatever the model says (also a prompt-injection defence).
// 2. One-click fixes may only use values found on the line's invoice or in its past payouts.
import type { LineContext } from './facts';
import type { Change, Fix, Flag, LineReview } from './review';

const lc = (s?: string) => (s ?? '').trim().toLowerCase();
const money = (s?: string) => (s && Number(s) > 0 ? Number(s) : NaN);

// Each floor finding names the AI flag type it matches, so a problem the AI already flagged is not shown twice.
type Finding = Flag & { matches: string };

function floor(c: LineContext): { flags: Finding[]; fix: Fix | null } {
  const r = c.row;
  if (c.before) {
    const inFlight = c.before.state === 'in_flight';
    return {
      flags: [{ type: 'code_check', matches: 'duplicate', reason: inFlight ? 'This invoice already has a payout in flight.' : 'This invoice was already paid.',
        evidence: `${c.before.invoice} ${c.before.date}` }],
      fix: { action: 'drop' },
    };
  }
  const inv = c.invoice;
  if (!inv) return { flags: [], fix: null };
  const flags: Finding[] = [];
  const changes: Change[] = [];
  if (!Number.isNaN(money(inv.amount)) && Number(r.amount) !== money(inv.amount)) {
    flags.push({ type: 'code_check', matches: 'amount', reason: 'The amount differs from the invoice.', evidence: `${r.amount} vs ${inv.amount}` });
    changes.push({ field: 'amount', value: money(inv.amount).toFixed(2) });
    if (inv.currency && inv.currency !== r.currency) changes.push({ field: 'currency', value: inv.currency });
  }
  const knownEmails = new Set(c.past.map(h => lc(h.email)));
  if (inv.payTo && lc(r.email) !== lc(inv.payTo) && !knownEmails.has(lc(r.email))) {
    flags.push({ type: 'code_check', matches: 'email_changed', reason: 'The email matches neither the invoice nor past payouts.', evidence: `invoice pay-to ${inv.payTo}` });
    changes.push({ field: 'email', value: inv.payTo });
  }
  return { flags, fix: changes.length ? { action: 'set', changes } : null };
}

function backed(ch: Change, c: LineContext) {
  const inv = c.invoice;
  if (ch.field === 'email') return [inv?.payTo, ...c.past.map(h => h.email)].some(e => e && lc(e) === lc(ch.value));
  if (ch.field === 'amount') return [inv?.amount, ...c.past.map(h => h.amount)].some(a => money(a) === money(ch.value));
  return [inv?.currency, ...c.past.map(h => h.currency)].some(x => x && x.toUpperCase() === ch.value.trim().toUpperCase());
}

const tidy = (ch: Change): Change => ({
  field: ch.field,
  value: ch.field === 'amount' ? money(ch.value).toFixed(2) : ch.field === 'currency' ? ch.value.trim().toUpperCase() : ch.value.trim(),
});

export function guardLine(lr: LineReview, c: LineContext): LineReview {
  let { verdict, flags, fix, fix_note } = lr;

  if (fix?.action === 'set') {
    const unbacked = fix.changes.filter(ch => !backed(ch, c));
    if (unbacked.length) {
      const said = unbacked.map(ch => `${ch.field} ${ch.value}`).join(', ');
      fix_note = [fix_note, `Suggested ${said} is not on the invoice or in past payouts, so there is no one-click fix.`].filter(Boolean).join(' ');
      fix = null;
    } else {
      fix = { action: 'set', changes: fix.changes.map(tidy) };
    }
  }

  const f = floor(c);
  if (f.flags.length) {
    if (verdict !== 'block') {
      verdict = 'block';
      const already = new Set(flags.map(x => x.type));
      flags = [...flags, ...f.flags.filter(x => !already.has(x.matches)).map(({ matches: _, ...flag }) => flag)];
    }
    fix = fix ?? f.fix;
  }
  return { ...lr, verdict, flags, fix, fix_note };
}
