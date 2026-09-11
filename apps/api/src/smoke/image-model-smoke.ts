import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const dataDir = mkdtempSync(join(tmpdir(), "image-model-smoke-"));
process.env.DATA_DIR = dataDir;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const requests: { url: string; body: string }[] = [];
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  requests.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString() });
  // Exercise the upstream fix for providers returning JSON as text.
  res.setHeader("Content-Type", "text/plain");
  res.end(JSON.stringify({ data: [{ b64_json: png }] }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const { createOpenAIImageProvider } = await import("../infrastructure/providers/image-provider.js");
const { parseGeneratePayload, parseEditPayload } = await import("../server/http/validation.js");
const { runTextToImageGeneration, runReferenceImageGeneration, getGenerationRecord, readStoredAssetMetadata, createRunningTextToImageGeneration, finishTextToImageGeneration } = await import("../domain/generation/image-generation.js");
const { getGalleryImages } = await import("../domain/project/project-store.js");
const { createGenerationPlan } = await import("../domain/agent/planner.js");
const { isExecutableGenerationPlan, executeGenerationPlan } = await import("../domain/agent/executor.js");
const { closeDatabase } = await import("../infrastructure/database.js");
const provider = createOpenAIImageProvider({ apiKey: "test", baseURL: `http://127.0.0.1:${address.port}/v1`, model: "gpt-image-2", timeoutMs: 5000 });

try {
  for (const model of ["gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
    for (const quality of ["xhigh", "max"]) {
      const payload = { model, quality, prompt: "A red square", presetId: "none", size: { width: 1024, height: 1024 }, count: 1, outputFormat: "png" };
      const parsed = parseGeneratePayload(payload);
      assert(parsed.ok);
      const generated = await runTextToImageGeneration(parsed.value, provider);
      assert.equal(generated.record.status, "succeeded");
      assert.equal(getGenerationRecord(generated.record.id)?.model, model);
      assert.equal((await readStoredAssetMetadata(generated.record.outputs[0]!.asset!.id))?.model, model);
      const sent = JSON.parse(requests.at(-1)!.body);
      assert.equal(sent.model, model);
      assert.equal(sent.quality, quality);
      assert.equal(requests.at(-1)!.url, "/v1/images/generations");
      const edit = parseEditPayload({ ...payload, referenceImages: [{ dataUrl: `data:image/png;base64,${png}` }] });
      assert(edit.ok);
      const edited = await runReferenceImageGeneration(edit.value, provider);
      assert.equal(edited.record.status, "succeeded");
      assert.equal(getGenerationRecord(edited.record.id)?.model, model);
      assert.equal(requests.at(-1)!.url, "/v1/images/edits");
      assert(requests.at(-1)!.body.includes(`name="model"\r\n\r\n${model}`));
      assert(requests.at(-1)!.body.includes(`name="quality"\r\n\r\n${quality}`));
      const planned = await createGenerationPlan({
        userText: payload.prompt,
        defaults: { ...payload, preservePrompt: true },
        llmConfig: { apiKey: "test", model: "unused", timeoutMs: 1000, supportsVision: false }
      });
      assert(planned.ok);
      assert.equal(planned.plan.defaults.model, model);
      assert(isExecutableGenerationPlan(planned.plan));
      const executed = await executeGenerationPlan({ plan: planned.plan, selectedReferences: [], mode: "execute", provider,
        requestId: "test", runId: "test", signal: new AbortController().signal, isRunActive: () => true, sendEvent: () => {} });
      assert.equal(executed.status, "succeeded");
      assert.equal(JSON.parse(requests.at(-1)!.body).model, model);
      assert.equal(JSON.parse(requests.at(-1)!.body).quality, quality);
    }
  }
  assert(getGalleryImages().items.every((item) => item.model?.startsWith("gpt-image-2.5")));
  const defaultPayload = parseGeneratePayload({ prompt: "Default model", size: { width: 1024, height: 1024 }, count: 1 });
  assert(defaultPayload.ok);
  const running = createRunningTextToImageGeneration(defaultPayload.value);
  const completed = await finishTextToImageGeneration(running.id, defaultPayload.value, provider);
  assert.equal(completed.model, "gpt-image-2");
  assert.equal((await readStoredAssetMetadata(completed.outputs[0]!.asset!.id))?.model, "gpt-image-2");
  assert.equal(parseGeneratePayload({ prompt: "test", size: { width: 1024, height: 1024 }, model: 42 }).ok, false);
  console.log("Image model, quality, generation/edit, Agent and history checks passed");
} finally {
  closeDatabase();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(dataDir, { recursive: true, force: true });
}
