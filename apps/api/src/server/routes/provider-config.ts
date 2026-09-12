import type { Hono } from "hono";
import { getProviderConfig, saveProviderConfig, getEnvironmentOpenAIImageProviderConfig, getLocalOpenAIImageProviderConfig } from "../../domain/providers/provider-config.js";
import { errorResponse, errorToMessage } from "../http/errors.js";
import { readJson } from "../http/json.js";
import { parseProviderConfigPayload } from "../http/validation.js";

export function registerProviderConfigRoutes(app: Hono): void {
  app.get("/api/provider-config", (c) => c.json(getProviderConfig()));


  app.get("/api/provider-config/:sourceId/models", async (c) => {
    const sourceId = c.req.param("sourceId");
    if (!["env-openai", "local-openai", "codex"].includes(sourceId)) {
      return c.json(errorResponse("invalid_provider", "Unknown image provider."), 400);
    }
    const config = sourceId === "env-openai" ? getEnvironmentOpenAIImageProviderConfig()
      : sourceId === "local-openai" ? getLocalOpenAIImageProviderConfig() : undefined;
    if (!config) return c.json({ models: [], discovered: false });
    const models = new Set([config.model]);
    try {
      const base = (config.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
      const url = new URL(base + "/models");
      const azure = url.hostname.endsWith(".services.ai.azure.com") || url.hostname.endsWith(".openai.azure.com");
      // Azure lists catalog models, not the user's callable deployment names.
      if (azure) return c.json({ models: [...models], discovered: false });
      const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` };
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000), redirect: "error" });
      if (!response.ok) throw new Error("Model discovery unavailable");
      const body = await response.json() as { data?: { id?: unknown }[] };
      for (const item of Array.isArray(body.data) ? body.data : []) {
        if (typeof item.id === "string" && /^(gpt-image-|dall-e-)/i.test(item.id)) models.add(item.id);
      }
      return c.json({ models: [...models], discovered: true });
    } catch {
      return c.json({ models: [...models], discovered: false });
    }
  });

  app.put("/api/provider-config", async (c) => {
    const payload = await readJson(c.req.raw);
    if (!payload.ok) {
      return c.json(payload.error, 400);
    }

    const parsed = parseProviderConfigPayload(payload.value);
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }

    try {
      return c.json(saveProviderConfig(parsed.value));
    } catch (error) {
      return c.json(errorResponse("provider_config_error", errorToMessage(error)), 400);
    }
  });
}
