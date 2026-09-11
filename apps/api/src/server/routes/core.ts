import type { Hono } from "hono";
import { GENERATION_COUNTS, IMAGE_MODELS, IMAGE_QUALITIES, OUTPUT_FORMATS, SIZE_PRESETS, STYLE_PRESETS, type AppConfig } from "../../domain/contracts.js";
import { getConfiguredImageModel } from "../../infrastructure/providers/image-provider.js";

export function registerCoreRoutes(app: Hono): void {
  app.get("/api/health", (c) =>
    c.json({
      status: "ok"
    })
  );

  app.get("/api/config", (c) => {
    const configuredModel = getConfiguredImageModel();
    const config: AppConfig = {
      model: configuredModel,
      models: Array.from(new Set([configuredModel, ...IMAGE_MODELS])),
      sizePresets: SIZE_PRESETS,
      stylePresets: STYLE_PRESETS,
      qualities: IMAGE_QUALITIES,
      outputFormats: OUTPUT_FORMATS,
      counts: GENERATION_COUNTS
    };

    return c.json(config);
  });
}
