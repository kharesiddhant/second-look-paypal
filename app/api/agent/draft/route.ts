import { requireOwner } from '@/lib/auth';
import { MAX_TOTAL, readInvoiceFiles, uploadParts } from '@/lib/batches';
import { startDraft } from '@/lib/agent';

// Draft a payout batch from a sentence (plus optional invoices and notes). Runs in the background;
// the page follows its steps at /api/agent/runs/[id] and opens the batch once it is submitted.
export async function POST(req: Request) {
  const denied = requireOwner(req);
  if (denied) return denied;
  if (Number(req.headers.get('content-length') ?? 0) > MAX_TOTAL + 1024 * 1024) {
    return Response.json({ error: 'The upload is over 20 MB in total' }, { status: 413 });
  }
  const form = await req.formData();
  const instruction = String(form.get('instruction') ?? '').trim();
  if (!instruction) return Response.json({ error: 'Describe the payout run first' }, { status: 400 });
  if (instruction.length > 1000) return Response.json({ error: 'Keep the instruction under 1,000 characters' }, { status: 400 });
  const parts = uploadParts(form);
  if ('error' in parts) return Response.json({ error: parts.error }, { status: parts.status });
  const runId = startDraft(instruction, async () => {
    const read = await readInvoiceFiles(parts.files);
    return { ...read, notes: [...parts.notes, ...read.notes] };
  });
  return Response.json({ runId });
}
