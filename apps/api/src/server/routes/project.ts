import type { Hono } from "hono";
import {
  getProjectState,
  ProjectSnapshotOverwriteRejectedError,
  ProjectStoreUnavailableError,
  saveProjectSnapshot
} from "../../domain/project/project-store.js";
import { saveReferenceImageInput } from "../../domain/generation/image-generation.js";
import { errorResponse } from "../http/errors.js";
import { readJson } from "../http/json.js";
import { logProjectSaveRejected, parseProjectPayload } from "../http/validation.js";

export function registerProjectRoutes(app: Hono): void {
  app.get("/api/project", (c) => {
    try {
      return c.json(getProjectState());
    } catch (error) {
      if (error instanceof ProjectStoreUnavailableError) {
        return c.json(
          errorResponse(
            error.code,
            "Saved project data could not be read safely. Stop editing and restore from a backup before continuing."
          ),
          503
        );
      }

      throw error;
    }
  });

  app.put("/api/project", async (c) => {
    const payload = await readJson(c.req.raw);
    if (!payload.ok) {
      logProjectSaveRejected(payload.error, c.req.raw);
      return c.json(payload.error, 400);
    }

    const compactedPayload = await compactProjectSnapshotImageAssets(payload.value);
    const parsed = parseProjectPayload(compactedPayload);
    if (!parsed.ok) {
      logProjectSaveRejected(parsed.error, c.req.raw);
      return c.json(parsed.error, 400);
    }

    try {
      return c.json(saveProjectSnapshot(parsed.value));
    } catch (error) {
      if (error instanceof ProjectSnapshotOverwriteRejectedError) {
        return c.json(
          errorResponse(
            error.code,
            "Refusing to overwrite a non-empty saved canvas with an empty snapshot. Reload the project before saving."
          ),
          409
        );
      }

      if (error instanceof ProjectStoreUnavailableError) {
        return c.json(
          errorResponse(
            error.code,
            "Saved project data could not be read safely. Stop editing and restore from a backup before continuing."
          ),
          503
        );
      }

      throw error;
    }
  });
}

async function compactProjectSnapshotImageAssets(payload: unknown): Promise<unknown> {
  if (!isRecord(payload) || !isRecord(payload.snapshot)) {
    return payload;
  }

  const dataUrlAssetCache = new Map<string, Awaited<ReturnType<typeof saveReferenceImageInput>>>();
  const stores = projectSnapshotStores(payload.snapshot);
  for (const store of stores) {
    for (const record of Object.values(store)) {
      if (!isImageAssetRecord(record)) {
        continue;
      }

      const sourceUrl = record.props.src;
      if (!sourceUrl.startsWith("data:image/")) {
        continue;
      }

      const cachedAsset = dataUrlAssetCache.get(sourceUrl);
      const asset =
        cachedAsset ??
        (await saveReferenceImageInput({
          dataUrl: sourceUrl,
          fileName: typeof record.props.name === "string" ? record.props.name : undefined
        }));
      dataUrlAssetCache.set(sourceUrl, asset);

      record.props = {
        ...record.props,
        src: asset.url,
        w: asset.width,
        h: asset.height,
        mimeType: asset.mimeType
      };
      record.meta = {
        ...(isRecord(record.meta) ? record.meta : {}),
        localAssetId: asset.id
      };
    }

    for (const record of Object.values(store)) {
      if (!isImageShapeRecord(record) || typeof record.props.url !== "string" || !record.props.url.startsWith("data:image/")) {
        continue;
      }

      const sourceAssetId = typeof record.props.assetId === "string" ? record.props.assetId : undefined;
      const assetRecord = sourceAssetId ? store[sourceAssetId] : undefined;
      if (isImageAssetRecord(assetRecord) && typeof assetRecord.props.src === "string" && assetRecord.props.src.startsWith("/api/assets/")) {
        record.props = {
          ...record.props,
          url: assetRecord.props.src
        };
      }
    }
  }

  return payload;
}

function projectSnapshotStores(snapshot: Record<string, unknown>): Record<string, unknown>[] {
  const stores: Record<string, unknown>[] = [];
  if (isRecord(snapshot.document) && isRecord(snapshot.document.store)) {
    stores.push(snapshot.document.store);
  }
  if (isRecord(snapshot.store)) {
    stores.push(snapshot.store);
  }
  return stores;
}

function isImageAssetRecord(value: unknown): value is {
  props: Record<string, unknown> & { src: string };
  meta?: unknown;
} {
  return (
    isRecord(value) &&
    value.typeName === "asset" &&
    value.type === "image" &&
    isRecord(value.props) &&
    typeof value.props.src === "string"
  );
}

function isImageShapeRecord(value: unknown): value is {
  props: Record<string, unknown> & { assetId?: unknown; url?: unknown };
} {
  return isRecord(value) && value.typeName === "shape" && value.type === "image" && isRecord(value.props);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
