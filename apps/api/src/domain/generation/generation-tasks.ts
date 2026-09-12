import type { GenerationRecord } from "../contracts.js";
import { createConfiguredImageProvider } from "../providers/image-provider-selection.js";
import type { EditImageProviderInput, ImageProviderInput } from "../../infrastructure/providers/image-provider.js";
import {
  cancelGenerationRecord,
  createRunningReferenceImageGeneration,
  createRunningTextToImageGeneration,
  failGenerationRecord,
  finishReferenceImageGeneration,
  finishTextToImageGeneration,
  getGenerationRecord,
  markInterruptedGenerationRecordsFailed
} from "./image-generation.js";

interface ActiveGenerationTask {
  controller: AbortController;
}

const activeGenerationTasks = new Map<string, ActiveGenerationTask>();

export function initializeGenerationTaskManager(): void {
  activeGenerationTasks.clear();
  markInterruptedGenerationRecordsFailed();
}

export async function startTextToImageGenerationTask(input: ImageProviderInput): Promise<GenerationRecord> {
  const provider = await createConfiguredImageProvider(undefined, input.providerSourceId);
  input = { ...input, providerSourceId: provider.providerSourceId, providerLabel: provider.providerLabel };
  const record = createRunningTextToImageGeneration(input);
  if (isTerminalGenerationStatus(record.status) || activeGenerationTasks.has(record.id)) {
    return record;
  }

  startBackgroundGenerationTask(record.id, async (signal) => {
    await finishTextToImageGeneration(record.id, { ...input, providerSourceId: provider.providerSourceId, providerLabel: provider.providerLabel }, provider, signal);
  });

  return record;
}

export async function startReferenceImageGenerationTask(input: EditImageProviderInput): Promise<GenerationRecord> {
  const provider = await createConfiguredImageProvider(undefined, input.providerSourceId);
  input = { ...input, providerSourceId: provider.providerSourceId, providerLabel: provider.providerLabel };
  const running = await createRunningReferenceImageGeneration(input);
  if (isTerminalGenerationStatus(running.record.status) || activeGenerationTasks.has(running.record.id)) {
    return running.record;
  }

  startBackgroundGenerationTask(running.record.id, async (signal) => {
    await finishReferenceImageGeneration(running.record.id, { ...running.input, providerSourceId: provider.providerSourceId, providerLabel: provider.providerLabel }, provider, signal);
  });

  return running.record;
}

export function readGenerationTaskRecord(generationId: string): GenerationRecord | undefined {
  return getGenerationRecord(generationId);
}

export function cancelGenerationTask(generationId: string): GenerationRecord | undefined {
  activeGenerationTasks.get(generationId)?.controller.abort();
  return cancelGenerationRecord(generationId);
}

function startBackgroundGenerationTask(generationId: string, run: (signal: AbortSignal) => Promise<void>): void {
  const controller = new AbortController();
  activeGenerationTasks.set(generationId, { controller });

  void (async () => {
    try {
      await run(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        cancelGenerationRecord(generationId);
      } else {
        failGenerationRecord(generationId, errorToMessage(error));
      }
    } finally {
      const activeTask = activeGenerationTasks.get(generationId);
      if (activeTask?.controller === controller) {
        activeGenerationTasks.delete(generationId);
      }
    }
  })();
}

function isTerminalGenerationStatus(status: GenerationRecord["status"]): boolean {
  return status === "succeeded" || status === "partial" || status === "failed" || status === "cancelled";
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Generation failed. Try again.";
}
