// Render Workflows service for big batches: reviews one 50-line chunk per task run.
// Deployed as its own Render service (render.yaml, type: workflow). The web app starts one run per chunk
// (lib/chunks.ts) and reads the result back; this service never touches the database or PayPal.
import { task, type TaskContext } from '@renderinc/sdk/workflows';
import { callReviewModel } from '../lib/review-model';

task(
  { name: 'reviewChunk', timeoutSeconds: 600, retry: { maxRetries: 2, waitDurationMs: 5000, backoffScaling: 2 } },
  async function reviewChunk(_ctx: TaskContext, system: string, content: string) {
    return callReviewModel(system, content);
  },
);
