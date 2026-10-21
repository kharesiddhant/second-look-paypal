import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { db } from './db';

export type Change = { field: 'email' | 'amount' | 'currency'; value: string };
export type Fix = { action: 'set'; changes: Change[] } | { action: 'drop' };
export type Flag = { type: string; reason: string; evidence: string };
export type LineReview = { line: number; verdict: 'ok' | 'review' | 'block'; flags: Flag[]; fix: Fix | null; fix_note: string | null };
export type Review = { lines: LineReview[]; summary: string };

const MODEL = 'claude-sonnet-5-5';

// Flat fix shape for the model; normalised to Fix below.
const ReviewSchema = z.object({
  lines: z.array(z.object({
    line: z.number().int(),
    verdict: z.enum(['ok', 'review', 'block']),
    flags: z.array(z.object({ type: z.string(), reason: z.string(), evidence: z.string() })),
    fix: z.object({
      action: z.enum(['set', 'drop']),
      changes: z.array(z.object({ field: z.enum(['email', 'amount', 'currency']), value: z.string() })),
    }).nullable(),
    fix_note: z.string().nullable(),
  })),
  summary: z.string(),
});

// ponytail: inputs are the fixed day1-test files; rules and invoices move to owner uploads in the depth phase.
export async function reviewBatch(csv: string): Promise<Review> {
  const history = (db().prepare('SELECT * FROM history ORDER BY date').all() as Record<string, string>[])
    .map(r => [r.date, r.name, r.email, r.amount, r.currency, r.invoice].join(','));

  const response = await new Anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: betaZodOutputFormat(ReviewSchema) },
    system: readFileSync('day1-test/reviewer-prompt.md', 'utf8'),
    messages: [{
      role: 'user',
      content: [
        `<payout.csv>\n${csv}\n</payout.csv>`,
        `<history.csv>\ndate,name,email,amount,currency,invoice\n${history.join('\n')}\n</history.csv>`,
        `<invoices.txt>\n${readFileSync('day1-test/invoices.txt', 'utf8')}\n</invoices.txt>`,
        `<rules.txt>\n${readFileSync('day1-test/rules.txt', 'utf8')}\n</rules.txt>`,
      ].join('\n\n'),
    }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Model declined the review');
  if (response.stop_reason === 'max_tokens') throw new Error('Review was cut off');
  const out = response.parsed_output;
  if (!out) throw new Error('Review output did not match the schema');

  return {
    summary: out.summary,
    lines: out.lines.map(l => ({
      ...l,
      fix: l.fix?.action === 'drop' ? { action: 'drop' }
        : l.fix?.changes.length ? { action: 'set', changes: l.fix.changes }
        : null,
    })),
  };
}
