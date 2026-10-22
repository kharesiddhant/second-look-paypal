// The Claude review call, shared by the web app (batches of up to 50 lines) and the Render Workflows
// task (one 50-line chunk of a bigger batch). Imports only npm packages, so the workflow service can run it.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

export const MODEL = 'claude-sonnet-5-5';
export const EFFORT = 'medium'; // was high; compared on payout.csv and blind-payout.csv with the same verdicts

// Clean lines come back as bare numbers in ok_lines; only flagged lines carry detail (saves output tokens).
const ReviewSchema = z.object({
  ok_lines: z.array(z.number().int()),
  lines: z.array(z.object({
    line: z.number().int(),
    verdict: z.enum(['review', 'block']),
    flags: z.array(z.object({ type: z.string(), reason: z.string(), evidence: z.string() })),
    fix: z.object({
      action: z.enum(['set', 'drop']),
      changes: z.array(z.object({ field: z.enum(['email', 'amount', 'currency']), value: z.string() })),
    }).nullable(),
    fix_note: z.string().nullable(),
  })),
  summary: z.string(),
});
export type ModelReview = z.infer<typeof ReviewSchema>;

// ponytail: one call per chunk, max_tokens 16000; chunks are 50 lines, far below the ~100 flagged-line ceiling.
export async function callReviewModel(system: string, content: string): Promise<ModelReview> {
  const response = await new Anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: EFFORT, format: betaZodOutputFormat(ReviewSchema) },
    system,
    messages: [{ role: 'user', content }],
  });
  console.log(`review usage: model=${response.model} effort=${EFFORT} in=${response.usage.input_tokens} out=${response.usage.output_tokens}`);
  if (response.stop_reason === 'refusal') throw new Error('Model declined the review');
  if (response.stop_reason === 'max_tokens') throw new Error('Review was cut off');
  if (!response.parsed_output) throw new Error('Review output did not match the schema');
  return response.parsed_output;
}
