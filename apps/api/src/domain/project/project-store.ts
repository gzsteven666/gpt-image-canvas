import { createHash } from "node:crypto";
import { readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { and, desc, eq, inArray } from "drizzle-orm";
import type {
  GeneratedAsset,
  GalleryImageItem,
  GalleryResponse,
  GenerationRecord as ApiGenerationRecord,
  GenerationStatus,
  ImageMode,
  ImageQuality,
  OutputFormat,
  OutputStatus,
  ProjectState
} from "../contracts.js";
import { db } from "../../infrastructure/database.js";
import { runtimePaths } from "../../infrastructure/runtime.js";
import { assets, generationOutputs, generationRecords, generationReferenceAssets, projects } from "../../infrastructure/schema.js";

export const DEFAULT_PROJECT_ID = "default";
const DEFAULT_PROJECT_NAME = "Default Project";
const PROJECT_SNAPSHOT_BACKUP_COUNT_LIMIT = readPositiveIntegerEnv("PROJECT_SNAPSHOT_BACKUP_MAX_COUNT", 20);
const PROJECT_SNAPSHOT_BACKUP_TOTAL_BYTES_LIMIT = readPositiveIntegerEnv(
  "PROJECT_SNAPSHOT_BACKUP_MAX_BYTES",
  256 * 1024 * 1024
);
const PROJECT_SNAPSHOT_BACKUP_MIN_COUNT = Math.min(
  readPositiveIntegerEnv("PROJECT_SNAPSHOT_BACKUP_MIN_COUNT", 3),
  PROJECT_SNAPSHOT_BACKUP_COUNT_LIMIT
);
const PROJECT_SNAPSHOT_BACKUP_MIN_INTERVAL_MS = readPositiveIntegerEnv(
  "PROJECT_SNAPSHOT_BACKUP_MIN_INTERVAL_MS",
  5 * 60 * 1000
);
const LARGE_PROJECT_SNAPSHOT_BYTES = 1024 * 1024;
const EMPTY_PROJECT_OVERWRITE_BYTES = 16 * 1024;
const EMPTY_PROJECT_STORE_RECORDS = 2;
const fallbackWarnings = new Set<string>();

interface ProjectSnapshotInput {
  name?: string;
  snapshotJson: string;
}

export interface GalleryExportAsset {
  outputId: string;
  assetId: string;
  fileName: string;
  mimeType: string;
}

export interface DeleteUnreferencedAssetResult {
  deleted: boolean;
  reason?: "not_found" | "canvas_reference" | "database_reference";
}

export interface GalleryAssetPurgeResult {
  deletedAssetIds: string[];
  deletedFileCount: number;
}

export class ProjectStoreUnavailableError extends Error {
  readonly code = "project_unavailable";
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ProjectStoreUnavailableError";
    this.cause = cause;
  }
}

export class ProjectSnapshotOverwriteRejectedError extends Error {
  readonly code = "project_snapshot_overwrite_rejected";
}

interface EnsureDefaultProjectOptions {
  backupExisting: boolean;
}

interface SnapshotStats {
  bytes: number;
  storeRecords: number;
  shapeRecords: number;
  assetRecords: number;
  meaningful: boolean;
}

interface ProjectSnapshotBackupFile {
  filePath: string;
  fileName: string;
  mtimeMs: number;
  size: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseSnapshot(snapshotJson: string): unknown | null {
  try {
    return JSON.parse(snapshotJson) as unknown;
  } catch (error) {
    throw new ProjectStoreUnavailableError("Saved project snapshot could not be parsed.", error);
  }
}

export function ensureDefaultProject(): void {
  ensureDefaultProjectRow({ backupExisting: true });
}

function ensureDefaultProjectRow(options: EnsureDefaultProjectOptions): void {
  const existing = getDefaultProjectRow();

  if (existing) {
    if (options.backupExisting) {
      tryWriteProjectSnapshotBackup(existing.snapshotJson, existing.updatedAt);
    }
    return;
  }
  if (defaultProjectRowExists()) {
    return;
  }

  const createdAt = nowIso();
  db.insert(projects)
    .values({
      id: DEFAULT_PROJECT_ID,
      name: DEFAULT_PROJECT_NAME,
      snapshotJson: "null",
      createdAt,
      updatedAt: createdAt
    })
    .run();
}

export function saveProjectSnapshot(input: ProjectSnapshotInput): ProjectState {
  ensureDefaultProjectRow({ backupExisting: false });

  const updatedAt = nowIso();
  const current = getDefaultProjectRow();
  if (current && shouldRejectDestructiveSnapshotSave(current.snapshotJson, input.snapshotJson)) {
    throw new ProjectSnapshotOverwriteRejectedError(
      "Refusing to overwrite a non-empty saved canvas with an empty snapshot."
    );
  }

  tryWriteProjectSnapshotBackup(input.snapshotJson, updatedAt);

  db.update(projects)
    .set({
      name: input.name ?? current?.name ?? DEFAULT_PROJECT_NAME,
      snapshotJson: input.snapshotJson,
      updatedAt
    })
    .where(eq(projects.id, DEFAULT_PROJECT_ID))
    .run();

  return getProjectState();
}

export function getProjectState(): ProjectState {
  ensureDefaultProject();

  const project = getDefaultProjectRow();

  if (!project) {
    return {
      id: DEFAULT_PROJECT_ID,
      name: DEFAULT_PROJECT_NAME,
      snapshot: null,
      history: getGenerationHistory(),
      updatedAt: nowIso()
    };
  }

  return {
    id: project.id,
    name: project.name,
    snapshot: parseSnapshot(project.snapshotJson),
    history: getGenerationHistory(),
    updatedAt: project.updatedAt
  };
}

export function getGalleryImages(): GalleryResponse {
  const rows = db
    .select({
      output: generationOutputs,
      generation: generationRecords,
      asset: assets
    })
    .from(generationOutputs)
    .innerJoin(generationRecords, eq(generationOutputs.generationId, generationRecords.id))
    .innerJoin(assets, eq(generationOutputs.assetId, assets.id))
    .where(eq(generationOutputs.status, "succeeded"))
    .orderBy(desc(generationOutputs.createdAt))
    .all();

  return {
    items: rows.map(({ output, generation, asset }) => ({
      outputId: output.id,
      generationId: generation.id,
      mode: generation.mode as ImageMode,
      prompt: generation.prompt,
      effectivePrompt: generation.effectivePrompt,
      presetId: generation.presetId,
      size: {
        width: generation.width,
        height: generation.height
      },
      quality: generation.quality as ImageQuality,
      model: generation.model ?? undefined,
      outputFormat: generation.outputFormat as OutputFormat,
      createdAt: output.createdAt,
      asset: toGeneratedAsset(asset)
    })).filter((item): item is typeof item & GalleryImageItem => Boolean(item.asset))
  };
}

export function deleteGalleryOutput(outputId: string): boolean {
  const output = db.select().from(generationOutputs).where(eq(generationOutputs.id, outputId)).get();
  if (!output) {
    return false;
  }

  const result = db.delete(generationOutputs).where(eq(generationOutputs.id, outputId)).run();
  if (result.changes > 0 && output.assetId) {
    deleteAssetWhenNoGalleryOutput(output.assetId);
  }
  return result.changes > 0;
}

export function deleteGalleryOutputs(outputIds: string[]): string[] {
  if (outputIds.length === 0) {
    return [];
  }

  const deletedOutputIds: string[] = [];
  for (const outputId of outputIds) {
    if (deleteGalleryOutput(outputId)) {
      deletedOutputIds.push(outputId);
    }
  }

  return deletedOutputIds;
}

export function deleteGalleryOutputsByAssetIds(assetIds: string[]): string[] {
  if (assetIds.length === 0) {
    return [];
  }

  const rows = db
    .select({
      outputId: generationOutputs.id
    })
    .from(generationOutputs)
    .where(and(inArray(generationOutputs.assetId, assetIds), eq(generationOutputs.status, "succeeded")))
    .all();

  return deleteGalleryOutputs(rows.map((row) => row.outputId));
}

export function deleteUnreferencedAsset(
  assetId: string,
  options: { canvasAssetIds?: string[] } = {}
): DeleteUnreferencedAssetResult {
  const trimmedAssetId = assetId.trim();
  if (!trimmedAssetId) {
    return { deleted: false, reason: "not_found" };
  }

  const asset = db.select().from(assets).where(eq(assets.id, trimmedAssetId)).get();
  if (!asset) {
    return { deleted: false, reason: "not_found" };
  }

  const canvasAssetIds = options.canvasAssetIds
    ? new Set(options.canvasAssetIds.map(normalizeAssetId).filter((id): id is string => Boolean(id)))
    : currentProjectCanvasAssetIds();
  if (canvasAssetIds.has(trimmedAssetId)) {
    return { deleted: false, reason: "canvas_reference" };
  }

  if (assetHasDatabaseReferences(trimmedAssetId)) {
    return { deleted: false, reason: "database_reference" };
  }

  db.delete(assets).where(eq(assets.id, trimmedAssetId)).run();
  deleteAssetFile(asset.relativePath);
  deleteAssetPreviewFiles(trimmedAssetId);
  return { deleted: true };
}

export function purgeAssetsOutsideGallery(): GalleryAssetPurgeResult {
  const retainedAssetIds = new Set(
    db.select({ assetId: generationOutputs.assetId })
      .from(generationOutputs)
      .where(and(eq(generationOutputs.status, "succeeded")))
      .all()
      .flatMap((row) => row.assetId ? [row.assetId] : [])
  );
  const allAssets = db.select().from(assets).all();
  const candidates = allAssets.filter((asset) => !retainedAssetIds.has(asset.id));
  const deletedAssetIds = candidates.map((asset) => asset.id);
  const retainedPaths = new Set(allAssets.filter((asset) => retainedAssetIds.has(asset.id)).map((asset) => asset.relativePath));

  if (deletedAssetIds.length > 0) {
    removeAssetsFromProjectSnapshot(deletedAssetIds);
    for (const asset of candidates) {
      deleteAssetAndReferences(asset);
    }
  }
  removeMissingDatabaseAssetRecordsFromProjectSnapshot(retainedAssetIds);

  let deletedFileCount = 0;
  for (const fileName of safeReadDir(runtimePaths.assetsDir)) {
    const relativePath = `assets/${fileName}`;
    if (!retainedPaths.has(relativePath)) {
      rmSync(join(runtimePaths.assetsDir, fileName), { force: true });
      deletedFileCount += 1;
    }
  }

  return { deletedAssetIds, deletedFileCount };
}

export function getGalleryExportAssets(outputIds: string[]): GalleryExportAsset[] {
  if (outputIds.length === 0) {
    return [];
  }

  const rows = db
    .select({
      outputId: generationOutputs.id,
      assetId: assets.id,
      fileName: assets.fileName,
      mimeType: assets.mimeType
    })
    .from(generationOutputs)
    .innerJoin(assets, eq(generationOutputs.assetId, assets.id))
    .where(and(inArray(generationOutputs.id, outputIds), eq(generationOutputs.status, "succeeded")))
    .all();

  const rowByOutputId = new Map(rows.map((row) => [row.outputId, row]));
  return outputIds.flatMap((outputId) => {
    const row = rowByOutputId.get(outputId);
    return row ? [row] : [];
  });
}

function getDefaultProjectRow(): (typeof projects.$inferSelect) | undefined {
  try {
    return db.select().from(projects).where(eq(projects.id, DEFAULT_PROJECT_ID)).get();
  } catch (error) {
    throw new ProjectStoreUnavailableError("Saved project row could not be read.", error);
  }
}

function defaultProjectRowExists(): boolean {
  try {
    const row = db.select({ id: projects.id }).from(projects).where(eq(projects.id, DEFAULT_PROJECT_ID)).get();
    return Boolean(row);
  } catch (error) {
    throw new ProjectStoreUnavailableError("Saved project row existence could not be checked.", error);
  }
}

function getGenerationHistory(): ApiGenerationRecord[] {
  try {
    return readGenerationHistory();
  } catch (error) {
    warnOnce(
      "history-read-fallback",
      `Generation history could not be read; returning an empty history. ${formatErrorSummary(error)}`
    );
    return [];
  }
}

function warnOnce(key: string, message: string): void {
  if (fallbackWarnings.has(key)) {
    return;
  }

  fallbackWarnings.add(key);
  console.warn(message);
}

function formatErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    const codeValue = (error as { code?: unknown }).code;
    const code = typeof codeValue === "string" ? `${codeValue}: ` : "";
    return `${code}${error.message}`;
  }

  return String(error);
}

function shouldRejectDestructiveSnapshotSave(currentSnapshotJson: string, nextSnapshotJson: string): boolean {
  const current = snapshotStats(currentSnapshotJson);
  const next = snapshotStats(nextSnapshotJson);

  return (
    current.meaningful &&
    current.bytes >= LARGE_PROJECT_SNAPSHOT_BYTES &&
    next.bytes <= EMPTY_PROJECT_OVERWRITE_BYTES &&
    next.storeRecords <= EMPTY_PROJECT_STORE_RECORDS &&
    next.shapeRecords === 0 &&
    next.assetRecords === 0
  );
}

function snapshotStats(snapshotJson: string): SnapshotStats {
  const bytes = Buffer.byteLength(snapshotJson, "utf8");
  const snapshot = parseSnapshot(snapshotJson);
  const store = snapshotStore(snapshot);
  const keys = store ? Object.keys(store) : [];
  const shapeRecords = keys.filter((key) => key.startsWith("shape:")).length;
  const assetRecords = keys.filter((key) => key.startsWith("asset:")).length;

  return {
    bytes,
    storeRecords: keys.length,
    shapeRecords,
    assetRecords,
    meaningful: bytes >= LARGE_PROJECT_SNAPSHOT_BYTES || shapeRecords > 0 || assetRecords > 0
  };
}

function snapshotStore(snapshot: unknown): Record<string, unknown> | undefined {
  if (!isRecord(snapshot)) {
    return undefined;
  }

  const document = snapshot.document;
  if (isRecord(document) && isRecord(document.store)) {
    return document.store;
  }

  return isRecord(snapshot.store) ? snapshot.store : undefined;
}

function currentProjectCanvasAssetIds(): Set<string> {
  const current = getDefaultProjectRow();
  const store = current ? snapshotStore(parseSnapshot(current.snapshotJson)) : undefined;
  return store ? canvasAssetIdsFromStore(store) : new Set();
}

function canvasAssetIdsFromStore(store: Record<string, unknown>): Set<string> {
  const assetIds = new Set<string>();
  for (const [key, value] of Object.entries(store)) {
    if (!key.startsWith("asset:") || !isRecord(value)) {
      continue;
    }

    const props = value.props;
    if (!isRecord(props)) {
      continue;
    }

    const assetId = normalizeAssetId(props.assetId);
    if (assetId) {
      assetIds.add(assetId);
    }
  }

  return assetIds;
}

function normalizeAssetId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function assetHasDatabaseReferences(assetId: string): boolean {
  const output = db.select({ id: generationOutputs.id }).from(generationOutputs).where(eq(generationOutputs.assetId, assetId)).get();
  if (output) {
    return true;
  }

  const reference = db
    .select({ id: generationReferenceAssets.generationId })
    .from(generationReferenceAssets)
    .where(eq(generationReferenceAssets.assetId, assetId))
    .get();
  if (reference) {
    return true;
  }

  const legacyReference = db
    .select({ id: generationRecords.id })
    .from(generationRecords)
    .where(eq(generationRecords.referenceAssetId, assetId))
    .get();
  return Boolean(legacyReference);
}

function deleteAssetWhenNoGalleryOutput(assetId: string): void {
  const hasGalleryOutput = db.select({ id: generationOutputs.id })
    .from(generationOutputs)
    .where(and(eq(generationOutputs.assetId, assetId), eq(generationOutputs.status, "succeeded")))
    .get();
  if (hasGalleryOutput) {
    return;
  }

  const asset = db.select().from(assets).where(eq(assets.id, assetId)).get();
  if (!asset) {
    return;
  }

  removeAssetsFromProjectSnapshot([assetId]);
  deleteAssetAndReferences(asset);
}

function deleteAssetAndReferences(asset: typeof assets.$inferSelect): void {
  db.delete(generationReferenceAssets).where(eq(generationReferenceAssets.assetId, asset.id)).run();
  db.update(generationRecords).set({ referenceAssetId: null }).where(eq(generationRecords.referenceAssetId, asset.id)).run();
  db.delete(generationOutputs).where(eq(generationOutputs.assetId, asset.id)).run();
  db.delete(assets).where(eq(assets.id, asset.id)).run();
  deleteAssetFile(asset.relativePath);
  deleteAssetPreviewFiles(asset.id);
}

function removeAssetsFromProjectSnapshot(assetIds: string[]): void {
  const current = getDefaultProjectRow();
  if (!current || assetIds.length === 0) {
    return;
  }

  const snapshot = parseSnapshot(current.snapshotJson);
  const store = snapshotStore(snapshot);
  if (!store) {
    return;
  }

  const tldrawAssetIds = new Set(assetIds.map((assetId) => `asset:${assetId}`));
  let changed = false;
  for (const [recordId, record] of Object.entries(store)) {
    if (tldrawAssetIds.has(recordId)) {
      delete store[recordId];
      changed = true;
      continue;
    }

    if (!isRecord(record) || record.typeName !== "shape" || record.type !== "image" || !isRecord(record.props)) {
      continue;
    }

    if (typeof record.props.assetId === "string" && tldrawAssetIds.has(record.props.assetId)) {
      delete store[recordId];
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  const updatedAt = nowIso();
  const snapshotJson = JSON.stringify(snapshot);
  tryWriteProjectSnapshotBackup(current.snapshotJson, updatedAt);
  db.update(projects)
    .set({ snapshotJson, updatedAt })
    .where(eq(projects.id, DEFAULT_PROJECT_ID))
    .run();
}

function removeMissingDatabaseAssetRecordsFromProjectSnapshot(validAssetIds: Set<string>): void {
  const current = getDefaultProjectRow();
  if (!current) {
    return;
  }

  const snapshot = parseSnapshot(current.snapshotJson);
  const store = snapshotStore(snapshot);
  if (!store) {
    return;
  }

  const validTldrawAssetIds = new Set([...validAssetIds].map((assetId) => `asset:${assetId}`));
  let changed = false;
  for (const [recordId, record] of Object.entries(store)) {
    if (!isRecord(record)) {
      continue;
    }

    if (record.typeName === "asset" && record.type === "image" && recordId.startsWith("asset:") && !validTldrawAssetIds.has(recordId)) {
      delete store[recordId];
      changed = true;
      continue;
    }

    if (record.typeName === "shape" && record.type === "image" && isRecord(record.props)) {
      const assetId = record.props.assetId;
      if (typeof assetId === "string" && assetId.startsWith("asset:") && !validTldrawAssetIds.has(assetId)) {
        delete store[recordId];
        changed = true;
      }
    }
  }

  if (!changed) {
    return;
  }

  const updatedAt = nowIso();
  tryWriteProjectSnapshotBackup(current.snapshotJson, updatedAt);
  db.update(projects)
    .set({ snapshotJson: JSON.stringify(snapshot), updatedAt })
    .where(eq(projects.id, DEFAULT_PROJECT_ID))
    .run();
}

function deleteAssetFile(relativePathValue: string): void {
  const filePath = resolve(runtimePaths.dataDir, relativePathValue);
  if (!isInsideDirectory(filePath, runtimePaths.assetsDir)) {
    return;
  }

  rmSync(filePath, { force: true });
}

function deleteAssetPreviewFiles(assetId: string): void {
  const prefix = `${safeFileSegment(assetId)}-`;
  for (const fileName of safeReadDir(runtimePaths.assetPreviewsDir)) {
    if (fileName.startsWith(prefix) && fileName.endsWith(".webp")) {
      rmSync(join(runtimePaths.assetPreviewsDir, fileName), { force: true });
    }
  }
}

function safeReadDir(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  const localPath = relative(directory, filePath);
  return Boolean(localPath) && !localPath.startsWith("..") && !isAbsolute(localPath);
}

function tryWriteProjectSnapshotBackup(snapshotJson: string, updatedAt: string): void {
  try {
    writeProjectSnapshotBackup(snapshotJson, updatedAt);
  } catch (error) {
    warnOnce("project-snapshot-backup-write-failed", `Project snapshot backup write failed. ${formatErrorSummary(error)}`);
  }

  try {
    pruneProjectSnapshotBackups();
  } catch (error) {
    warnOnce("project-snapshot-backup-prune-failed", `Project snapshot backup prune failed. ${formatErrorSummary(error)}`);
  }
}

function writeProjectSnapshotBackup(snapshotJson: string, updatedAt: string): void {
  const stats = snapshotStats(snapshotJson);
  if (!stats.meaningful) {
    return;
  }

  const hash = createHash("sha256").update(snapshotJson).digest("hex");
  if (backupExists(hash)) {
    return;
  }
  if (shouldDelayProjectSnapshotBackup()) {
    return;
  }

  const timestamp = safeTimestamp(updatedAt);
  const hashPrefix = hash.slice(0, 16);
  const fileName = `${timestamp}-${hashPrefix}.json.gz`;
  const tempFileName = `.${fileName}.${process.pid}.tmp`;
  const finalPath = join(runtimePaths.projectSnapshotBackupsDir, fileName);
  const tempPath = join(runtimePaths.projectSnapshotBackupsDir, tempFileName);

  writeFileSync(tempPath, gzipSync(snapshotJson));
  renameSync(tempPath, finalPath);
}

function backupExists(hash: string): boolean {
  const hashPrefix = hash.slice(0, 16);
  return readdirSync(runtimePaths.projectSnapshotBackupsDir).some((fileName) =>
    fileName.endsWith(`${hashPrefix}.json.gz`)
  );
}

function shouldDelayProjectSnapshotBackup(): boolean {
  const latestBackup = readProjectSnapshotBackups()[0];
  if (!latestBackup) {
    return false;
  }

  return Date.now() - latestBackup.mtimeMs < PROJECT_SNAPSHOT_BACKUP_MIN_INTERVAL_MS;
}

function pruneProjectSnapshotBackups(): void {
  const backups = readProjectSnapshotBackups();
  let keptCount = 0;
  let keptBytes = 0;

  for (const backup of backups) {
    const keepForRecoveryFloor = keptCount < PROJECT_SNAPSHOT_BACKUP_MIN_COUNT;
    const keepWithinCountLimit = keptCount < PROJECT_SNAPSHOT_BACKUP_COUNT_LIMIT;
    const keepWithinBytesLimit = keptBytes + backup.size <= PROJECT_SNAPSHOT_BACKUP_TOTAL_BYTES_LIMIT;

    if (keepForRecoveryFloor || (keepWithinCountLimit && keepWithinBytesLimit)) {
      keptCount += 1;
      keptBytes += backup.size;
      continue;
    }

    rmSync(backup.filePath, { force: true });
  }
}

function readProjectSnapshotBackups(): ProjectSnapshotBackupFile[] {
  return readdirSync(runtimePaths.projectSnapshotBackupsDir)
    .flatMap((fileName): ProjectSnapshotBackupFile[] => {
      if (!fileName.endsWith(".json.gz")) {
        return [];
      }

      const filePath = join(runtimePaths.projectSnapshotBackupsDir, fileName);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(filePath);
      } catch {
        return [];
      }
      if (!stats.isFile()) {
        return [];
      }

      return [
        {
          filePath,
          fileName,
          mtimeMs: stats.mtimeMs,
          size: stats.size
        }
      ];
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.fileName.localeCompare(left.fileName));
}

function safeTimestamp(value: string): string {
  const date = new Date(value);
  const iso = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();

  return iso.replace(/[:.]/gu, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readGenerationHistory(): ApiGenerationRecord[] {
  const records = db.select().from(generationRecords).orderBy(desc(generationRecords.createdAt)).limit(20).all();
  if (records.length === 0) {
    return [];
  }

  const generationIds = records.map((record) => record.id);
  const outputs = db
    .select()
    .from(generationOutputs)
    .where(inArray(generationOutputs.generationId, generationIds))
    .orderBy(generationOutputs.createdAt)
    .all();
  const referenceRows = db
    .select()
    .from(generationReferenceAssets)
    .where(inArray(generationReferenceAssets.generationId, generationIds))
    .all()
    .sort((left, right) =>
      left.generationId === right.generationId
        ? left.position - right.position
        : left.generationId.localeCompare(right.generationId)
    );

  const assetIds = outputs.flatMap((output) => (output.assetId ? [output.assetId] : []));
  const assetRows =
    assetIds.length > 0 ? db.select().from(assets).where(inArray(assets.id, assetIds)).all() : [];
  const assetById = new Map(assetRows.map((asset) => [asset.id, asset]));

  const outputsByGenerationId = new Map<string, typeof outputs>();
  for (const output of outputs) {
    const existing = outputsByGenerationId.get(output.generationId) ?? [];
    existing.push(output);
    outputsByGenerationId.set(output.generationId, existing);
  }
  const referenceAssetIdsByGenerationId = new Map<string, string[]>();
  for (const referenceRow of referenceRows) {
    const existing = referenceAssetIdsByGenerationId.get(referenceRow.generationId) ?? [];
    existing.push(referenceRow.assetId);
    referenceAssetIdsByGenerationId.set(referenceRow.generationId, existing);
  }

  return records.map((record) => {
    const mappedOutputs = (outputsByGenerationId.get(record.id) ?? []).map((output) => ({
      id: output.id,
      status: output.status as OutputStatus,
      asset: output.assetId ? toGeneratedAsset(assetById.get(output.assetId)) : undefined,
      error: output.error ?? undefined
    }));

    return {
      id: record.id,
      mode: record.mode as ImageMode,
      prompt: record.prompt,
      effectivePrompt: record.effectivePrompt,
      presetId: record.presetId,
      size: {
        width: record.width,
        height: record.height
      },
      quality: record.quality as ImageQuality,
      model: record.model ?? undefined,
      outputFormat: record.outputFormat as OutputFormat,
      count: record.count,
      status: record.status as GenerationStatus,
      error: record.error ?? undefined,
      referenceAssetIds: referenceAssetIdsByGenerationId.get(record.id) ?? (record.referenceAssetId ? [record.referenceAssetId] : undefined),
      referenceAssetId: record.referenceAssetId ?? undefined,
      createdAt: record.createdAt,
      outputs: mappedOutputs
    };
  });
}

function toGeneratedAsset(asset: (typeof assets.$inferSelect) | undefined): GeneratedAsset | undefined {
  if (!asset) {
    return undefined;
  }

  return {
    id: asset.id,
    url: `/api/assets/${asset.id}`,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    cloud:
      (asset.cloudProvider === "cos" || asset.cloudProvider === "s3") && (asset.cloudStatus === "uploaded" || asset.cloudStatus === "failed")
        ? {
            provider: asset.cloudProvider,
            status: asset.cloudStatus,
            lastError: asset.cloudError ?? undefined,
            uploadedAt: asset.cloudUploadedAt ?? undefined
          }
        : undefined
  };
}
