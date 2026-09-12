import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { Hono } from "hono";

const dataDir = mkdtempSync(join(tmpdir(), "provider-switch-smoke-"));
process.env.DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = "test-env-key";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const requests: string[] = [];
let release: (() => void) | undefined;
let hold = true;
const server = createServer(async (req, res) => {
  if (req.url?.endsWith("/models")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "gpt-image-2" }, { id: "gpt-image-2.5" }, { id: "gpt-5.5" }, { id: "gemini-3.1-flash-image" }] }));
    return;
  }
  for await (const _chunk of req) { /* Consume the image request. */ }
  requests.push(req.url ?? "");
  if (hold) await new Promise<void>((done) => { release = done; });
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ data: [{ b64_json: png }] }));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
process.env.OPENAI_BASE_URL = base + "/env/v1";
const { saveProviderConfig, getLocalOpenAIImageProviderConfig } = await import("../domain/providers/provider-config.js");
const { createConfiguredImageProvider } = await import("../domain/providers/image-provider-selection.js");
const { startTextToImageGenerationTask, readGenerationTaskRecord } = await import("../domain/generation/generation-tasks.js");
const { parseGeneratePayload } = await import("../server/http/validation.js");
const { getGalleryImages } = await import("../domain/project/project-store.js");
const { registerProviderConfigRoutes } = await import("../server/routes/provider-config.js");
const { closeDatabase } = await import("../infrastructure/database.js");
const app = new Hono();
registerProviderConfigRoutes(app);
try {
  saveProviderConfig({ sourceOrder: ["env-openai", "local-openai", "codex"],
    localOpenAI: { apiKey: "test-local-key", baseUrl: base + "/local/v1", model: "gpt-image-2", timeoutMs: 5000 } });
  const before = getLocalOpenAIImageProviderConfig();
  const parsed = parseGeneratePayload({ providerSourceId: "env-openai", prompt: "test", size: { width: 1024, height: 1024 }, count: 1 });
  assert(parsed.ok);
  const running = await startTextToImageGenerationTask(parsed.value);
  for (let i = 0; i < 100 && !release; i++) await new Promise((done) => setTimeout(done, 20));
  assert(release);
  const switched = await app.request("/api/provider-config", { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceOrder: ["local-openai", "env-openai", "codex"] }) });
  assert.equal(switched.status, 200);
  assert.deepEqual(getLocalOpenAIImageProviderConfig(), before);
  assert.equal((await createConfiguredImageProvider()).providerSourceId, "local-openai");
  assert.equal((await createConfiguredImageProvider(undefined, "env-openai")).providerSourceId, "env-openai");
  hold = false;
  release();
  for (let i = 0; i < 100 && readGenerationTaskRecord(running.id)?.status === "running"; i++) await new Promise((done) => setTimeout(done, 30));
  assert.equal(readGenerationTaskRecord(running.id)?.status, "succeeded");
  assert.equal(readGenerationTaskRecord(running.id)?.providerSourceId, "env-openai");
  assert.equal(getGalleryImages().items[0]?.providerSourceId, "env-openai");
  assert.deepEqual(requests, ["/env/v1/images/generations"]);
  const discovered = await (await app.request("/api/provider-config/local-openai/models")).json();
  assert.deepEqual(discovered.models, ["gpt-image-2", "gpt-image-2.5"]);
  assert(!JSON.stringify(discovered).includes("test-local-key"));
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:1/v1";
  const fallback = await (await app.request("/api/provider-config/env-openai/models")).json();
  assert.equal(fallback.discovered, false);
  assert(fallback.models.length > 0);
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(createConfiguredImageProvider(undefined, "env-openai"));
  assert.equal((await createConfiguredImageProvider()).providerSourceId, "local-openai");
  assert.equal(parseGeneratePayload({ ...parsed.value, providerSourceId: "invalid" }).ok, false);
  console.log("Provider switching, pinned tasks, history, model discovery/fallback and config preservation passed");
} finally {
  release?.();
  closeDatabase();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  assert(resolve(dataDir).startsWith(resolve(tmpdir()) + sep));
  rmSync(dataDir, { recursive: true, force: true });
}
