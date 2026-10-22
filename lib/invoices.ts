// Invoice files uploaded by the owner. Demo-format text is parsed directly; anything else
// (PDFs, free-form text) is read once by Claude Haiku 5.5 into structured fields.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { parseInvoices, type Invoice } from './facts';

const Extracted = z.object({
  invoices: z.array(z.object({
    id: z.string(), from: z.string(), pay_to_email: z.string(), amount: z.string(), currency: z.string(),
  })),
});

const PROMPT = `Extract every invoice in this file.
id: the invoice number exactly as written. from: who issued the invoice.
pay_to_email: the PayPal or payment email the invoice asks to be paid at, or "" if there is none.
amount: the invoice total as a plain decimal such as 850.00. currency: the three-letter ISO code.
Return an empty list if the file holds no invoice.`;

export async function readInvoiceFile(file: File): Promise<{ invoices: Invoice[]; notes: string[] }> {
  const bytes = Buffer.from(await file.arrayBuffer());
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf && /^=== .+ ===/m.test(bytes.toString('utf8'))) return parseInvoices(bytes.toString('utf8'));

  const content: Anthropic.ContentBlockParam[] = isPdf
    ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } },
       { type: 'text', text: PROMPT }]
    : [{ type: 'text', text: `${PROMPT}\n\n<file>\n${bytes.toString('utf8')}\n</file>` }];

  // Haiku 5.5 has no server-side fallback, so no fallbacks parameter; a refusal just marks the file unreadable.
  const res = await new Anthropic().messages.parse({
    model: 'claude-haiku-5-5',
    max_tokens: 4000,
    output_config: { effort: 'low', format: zodOutputFormat(Extracted) },
    messages: [{ role: 'user', content }],
  });
  console.log(`invoice extract usage: ${file.name} in=${res.usage.input_tokens} out=${res.usage.output_tokens}`);
  if (res.stop_reason !== 'end_turn' || !res.parsed_output) throw new Error(`could not read (${res.stop_reason})`);
  return {
    invoices: res.parsed_output.invoices.map(i => ({
      // "1,200.00" or "$850" become plain decimals so they compare with CSV amounts.
      id: i.id.trim(), from: i.from, payTo: i.pay_to_email.trim(), amount: i.amount.replace(/[^\d.]/g, ''),
      currency: i.currency.trim().toUpperCase(),
    })),
    notes: [],
  };
}
