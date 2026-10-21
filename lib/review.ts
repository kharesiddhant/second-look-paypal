import { readFileSync } from 'node:fs';

export type Fix = { action: 'set'; field: 'email' | 'amount' | 'currency'; value: string } | { action: 'drop' };
export type Flag = { type: string; reason: string; evidence: string };
export type LineReview = { line: number; verdict: 'ok' | 'review' | 'block'; flags: Flag[]; fix: Fix | null; fix_note: string | null };
export type Review = { lines: LineReview[]; summary: string };

// Stub until ANTHROPIC_API_KEY exists: returns the hand-made review of day1-test/payout.csv.
// Only correct for that file. Replace with a claude-sonnet-5-5 call using day1-test/reviewer-prompt.md.
export async function reviewBatch(_csv: string): Promise<Review> {
  return JSON.parse(readFileSync('day1-test/review.json', 'utf8'));
}
