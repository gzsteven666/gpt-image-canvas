import OpenAI, { APIConnectionTimeoutError, APIError, APIUserAbortError, toFile } from "openai";
import type { ImageEditParamsNonStreaming, ImageGenerateParamsNonStreaming, ImagesResponse } from "openai/resources/images";
import {
  IMAGE_MODEL,
  type ImageQuality,
  type ImageSize,
  type OutputFormat,
  type ReferenceImageInput
} from "../../domain/contracts.js";

export interface ImageProviderInput {
  providerSourceId?: string;
  providerLabel?: string;
  model?: string;
  originalPrompt: string;
  clientRequestId?: string;
  presetId: string;
  prompt: string;
  size: ImageSize;
  sizeApiValue: string;
  quality: ImageQuality;
  outputFormat: OutputFormat;
  count: number;
}

export interface EditImageProviderInput extends ImageProviderInput {
  referenceImages: ReferenceImageInput[];
  referenceImage?: ReferenceImageInput;
  referenceAssetIds?: string[];
  referenceAssetId?: string;
}

export interface ProviderImage {
  b64Json: string;
}

export interface ProviderResult {
  model: string;
  size: string;
  images: ProviderImage[];
}

export interface ImageProvider {
  providerSourceId?: string;
  providerLabel?: string;
  retryTransientErrors?: boolean;
  generate(input: ImageProviderInput, signal?: AbortSignal): Promise<ProviderResult>;
  edit(input: EditImageProviderInput, signal?: AbortSignal): Promise<ProviderResult>;
}

export type ProviderErrorCode = "missing_api_key" | "missing_provider" | "unsupported_provider_behavior" | "upstream_failure";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export interface OpenAIImageProviderConfig {
  apiKey: string;
  baseURL?: string;
  endpointMode?: OpenAIImageEndpointMode;
  model: string;
  timeoutMs: number;
}

export type OpenAIImageEndpointMode = "images" | "chat-completions";

export const DEFAULT_OPENAI_IMAGE_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_PROVIDER_IMAGE_BYTES = 100 * 1024 * 1024;
const SUPPORTED_REFERENCE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

type FlexibleImageGenerateParams = Omit<ImageGenerateParamsNonStreaming, "size" | "quality"> & {
  quality: ImageQuality | undefined;
  size: string;
};

type FlexibleImageEditParams = Omit<ImageEditParamsNonStreaming, "size" | "quality"> & {
  quality: ImageQuality | undefined;
  size: string;
};

type ProviderImagesResponse = ImagesResponse | string;

export function getOpenAIImageProviderConfig():
  | {
      ok: true;
      config: OpenAIImageProviderConfig;
    }
  | {
      ok: false;
      error: ProviderError;
    } {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      error: new ProviderError("missing_api_key", "服务器缺少 OPENAI_API_KEY，无法生成图像。", 500)
    };
  }

  const baseURL = process.env.OPENAI_BASE_URL?.trim();

  return {
    ok: true,
    config: {
      apiKey,
      baseURL: baseURL || undefined,
      endpointMode: parseOpenAIImageEndpointMode(process.env.OPENAI_IMAGE_ENDPOINT),
      model: getConfiguredImageModel(),
      timeoutMs: parseOpenAIImageTimeoutMs(process.env.OPENAI_IMAGE_TIMEOUT_MS)
    }
  };
}

export function getConfiguredImageModel(): string {
  return process.env.OPENAI_IMAGE_MODEL?.trim() || IMAGE_MODEL;
}

export function parseOpenAIImageTimeoutMs(value: string | undefined): number {
  return parsePositiveInteger(value, DEFAULT_OPENAI_IMAGE_TIMEOUT_MS);
}

export function parseOpenAIImageEndpointMode(value: string | undefined): OpenAIImageEndpointMode {
  return value?.trim().toLowerCase() === "chat-completions" ? "chat-completions" : "images";
}

export function createOpenAIImageProvider(config: OpenAIImageProviderConfig): ImageProvider {
  return new OpenAIImageProvider(config);
}

class OpenAIImageProvider implements ImageProvider {
  readonly retryTransientErrors = false;
  private readonly client: OpenAI;
  private readonly isAzureEndpoint: boolean;

  constructor(private readonly config: OpenAIImageProviderConfig) {
    this.isAzureEndpoint = isAzureOpenAIEndpoint(config.baseURL);
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      ...(this.isAzureEndpoint
        ? {
            defaultHeaders: { Authorization: null, "api-key": config.apiKey },
            defaultQuery: { "api-version": "preview" }
          }
        : {}),
      maxRetries: 0,
      timeout: config.timeoutMs
    });
  }

  async generate(input: ImageProviderInput, signal?: AbortSignal): Promise<ProviderResult> {
    try {
      if (this.config.endpointMode === "chat-completions") {
        return await this.chatCompletion(input, [], signal);
      }

      if (this.isAzureEndpoint) {
        return await this.azureGenerate(input, signal);
      }

      const response = await this.client.images.generate(
        imageGenerateRequestBody({
          model: input.model ?? this.config.model,
          prompt: input.prompt,
          size: input.sizeApiValue,
          quality: providerImageQuality(input.quality, this.isAzureEndpoint),
          output_format: input.outputFormat,
          n: input.count
        }),
        { signal }
      );

      return await normalizeProviderResponse(response, input.sizeApiValue, input.model ?? this.config.model, signal);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  private async azureGenerate(input: ImageProviderInput, signal?: AbortSignal): Promise<ProviderResult> {
    const baseURL = this.config.baseURL?.replace(/\/+$/, "");
    if (!baseURL) {
      throw new ProviderError("missing_provider", "Azure OpenAI 图像服务缺少 BASE URL。", 500);
    }

    const quality = providerImageQuality(input.quality, true);
    const response = await fetch(`${baseURL}/images/generations?api-version=preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.config.apiKey
      },
      body: JSON.stringify({
        model: input.model ?? this.config.model,
        prompt: input.prompt,
        n: input.count,
        size: input.sizeApiValue,
        ...(quality ? { quality } : {}),
        output_format: input.outputFormat
      }),
      signal
    });
    const responseText = await response.text();

    if (!response.ok) {
      throw new ProviderError(
        "upstream_failure",
        providerResponseErrorMessage(responseText) || `Azure OpenAI 图像服务请求失败（HTTP ${response.status}）。`,
        providerHttpStatus(response.status)
      );
    }

    return normalizeProviderResponse(responseText, input.sizeApiValue, input.model ?? this.config.model, signal);
  }

  async edit(input: EditImageProviderInput, signal?: AbortSignal): Promise<ProviderResult> {
    try {
      if (this.config.endpointMode === "chat-completions") {
        return await this.chatCompletion(input, input.referenceImages, signal);
      }

      const references = await Promise.all(input.referenceImages.map((referenceImage) => dataUrlToFile(referenceImage)));
      const response = await this.client.images.edit(
        imageEditRequestBody({
          model: input.model ?? this.config.model,
          image: references,
          prompt: input.prompt,
          size: input.sizeApiValue,
          quality: providerImageQuality(input.quality, this.isAzureEndpoint),
          output_format: input.outputFormat,
          n: input.count
        }),
        { signal }
      );

      return await normalizeProviderResponse(response, input.sizeApiValue, input.model ?? this.config.model, signal);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  private async chatCompletion(
    input: ImageProviderInput,
    referenceImages: ReferenceImageInput[],
    signal?: AbortSignal
  ): Promise<ProviderResult> {
    const content = referenceImages.length
      ? [
          { type: "text", text: input.prompt },
          ...referenceImages.map((reference) => ({
            type: "image_url",
            image_url: { url: reference.dataUrl }
          }))
        ]
      : input.prompt;
    const response = await this.client.post<unknown>("/chat/completions", {
      body: {
        model: input.model ?? this.config.model,
        messages: [{ role: "user", content }],
        n: input.count,
        output_format: input.outputFormat,
        quality: input.quality,
        size: input.sizeApiValue,
        stream: false
      },
      signal
    });

    return normalizeChatCompletionResponse(response, input.sizeApiValue, input.model ?? this.config.model, signal);
  }
}

function imageGenerateRequestBody(body: FlexibleImageGenerateParams): ImageGenerateParamsNonStreaming {
  // The SDK's image size union can lag gpt-image-2's documented flexible-size support.
  return body as unknown as ImageGenerateParamsNonStreaming;
}

function imageEditRequestBody(body: FlexibleImageEditParams): ImageEditParamsNonStreaming {
  // The SDK's image size union can lag gpt-image-2's documented flexible-size support.
  return body as unknown as ImageEditParamsNonStreaming;
}

function isAzureOpenAIEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) {
    return false;
  }

  try {
    const hostname = new URL(baseURL).hostname.toLowerCase();
    return hostname.endsWith(".services.ai.azure.com") || hostname.endsWith(".openai.azure.com");
  } catch {
    return false;
  }
}

function providerImageQuality(quality: ImageQuality, isAzureEndpoint: boolean): ImageQuality | undefined {
  return isAzureEndpoint && quality === "auto" ? undefined : quality;
}

function providerResponseErrorMessage(responseText: string): string | undefined {
  try {
    const payload = JSON.parse(responseText) as unknown;
    if (!isRecord(payload)) {
      return undefined;
    }

    const error = payload.error;
    if (isRecord(error) && typeof error.message === "string") {
      return error.message;
    }

    return typeof payload.message === "string" ? payload.message : undefined;
  } catch {
    return undefined;
  }
}

function toProviderError(error: unknown): Error {
  if (isAbortError(error)) {
    return error;
  }

  if (error instanceof ProviderError) {
    return error;
  }

  if (error instanceof APIConnectionTimeoutError) {
    return new ProviderError("upstream_failure", "OpenAI 图像服务请求超时，请稍后重试或降低分辨率。", 504);
  }

  if (error instanceof APIError) {
    return new ProviderError("upstream_failure", error.message || "OpenAI 图像服务请求失败。", providerHttpStatus(error.status));
  }

  if (error instanceof Error && error.message) {
    return new ProviderError("upstream_failure", error.message, 502);
  }

  return new ProviderError("upstream_failure", "OpenAI 图像服务请求失败。", 502);
}

function providerHttpStatus(status: number | undefined): number {
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isAbortError(error: unknown): error is Error {
  return error instanceof APIUserAbortError || (error instanceof DOMException && error.name === "AbortError");
}

async function normalizeProviderResponse(
  rawResponse: ProviderImagesResponse,
  sizeApiValue: string,
  model: string,
  signal?: AbortSignal
): Promise<ProviderResult> {
  const response = parseProviderImagesResponse(rawResponse);
  const data = isRecord(response) ? response.data : undefined;

  if (!Array.isArray(data) || data.length === 0) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像服务没有返回图像结果。", 502);
  }

  const images = await Promise.all(data.map((item) => providerImageFromResponseItem(item, signal)));

  if (images.some((image) => !image.b64Json)) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像服务没有返回 base64 图像数据。", 502);
  }

  return {
    model,
    size: sizeApiValue,
    images
  };
}

function parseProviderImagesResponse(response: ProviderImagesResponse): unknown {
  if (typeof response !== "string") {
    return response;
  }

  const responseText = response.trim();
  if (!responseText.startsWith("{") && !responseText.startsWith("[")) {
    return response;
  }

  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return response;
  }
}

async function providerImageFromResponseItem(item: unknown, signal?: AbortSignal): Promise<ProviderImage> {
  if (!isRecord(item)) {
    return {
      b64Json: ""
    };
  }

  if (typeof item.b64_json === "string" && item.b64_json) {
    return {
      b64Json: item.b64_json
    };
  }

  if (typeof item.url === "string" && item.url) {
    return {
      b64Json: await downloadProviderImageUrl(item.url, signal)
    };
  }

  return {
    b64Json: ""
  };
}

async function normalizeChatCompletionResponse(
  response: unknown,
  sizeApiValue: string,
  model: string,
  signal?: AbortSignal
): Promise<ProviderResult> {
  const candidates = chatCompletionImageCandidates(response);
  if (candidates.length === 0) {
    throw new ProviderError("unsupported_provider_behavior", "Chat Completions 没有返回可识别的图像结果。", 502);
  }

  const images = await Promise.all(
    candidates.map(async (candidate) => ({
      b64Json: candidate.kind === "base64" ? candidate.value : await downloadProviderImageUrl(candidate.value, signal)
    }))
  );

  return {
    model,
    size: sizeApiValue,
    images
  };
}

type ChatImageCandidate = { kind: "base64" | "url"; value: string };

function chatCompletionImageCandidates(response: unknown): ChatImageCandidate[] {
  const candidates: ChatImageCandidate[] = [];
  const seen = new Set<string>();

  function add(kind: ChatImageCandidate["kind"], value: unknown): void {
    if (typeof value !== "string" || !value.trim()) {
      return;
    }
    const normalized = value.trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      candidates.push({ kind, value: normalized });
    }
  }

  function visit(value: unknown, key?: string): void {
    if (typeof value === "string") {
      if (key === "b64_json") {
        add("base64", value);
        return;
      }

      for (const match of value.matchAll(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/giu)) {
        add("url", match[0]);
      }
      for (const match of value.matchAll(/https?:\/\/[^\s)'"<>]+/giu)) {
        add("url", match[0]);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key));
      return;
    }

    if (!isRecord(value)) {
      return;
    }

    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey === "url" && typeof childValue === "string") {
        add("url", childValue);
      } else {
        visit(childValue, childKey);
      }
    }
  }

  visit(response);
  return candidates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function downloadProviderImageUrl(url: string, signal?: AbortSignal): Promise<string> {
  const parsedUrl = parseProviderImageUrl(url);
  if (!parsedUrl) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像服务返回的图片 URL 不受支持。", 502);
  }

  if (parsedUrl.protocol === "data:") {
    return dataUrlToBase64(url);
  }

  const response = await fetch(parsedUrl, { signal });
  if (!response.ok) {
    throw new ProviderError("upstream_failure", "OpenAI 图像 URL 下载失败。", providerHttpStatus(response.status));
  }

  if (!isProviderImageContentType(response.headers.get("content-type"))) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像 URL 返回的内容不是图片。", 502);
  }

  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > MAX_PROVIDER_IMAGE_BYTES) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像 URL 返回的文件过大。", 502);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_PROVIDER_IMAGE_BYTES) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像 URL 返回的文件过大。", 502);
  }
  if (!isProviderImageBytes(bytes)) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像 URL 返回的内容不是可识别的图片。", 502);
  }

  return bytes.toString("base64");
}

function parseProviderImageUrl(url: string): URL | undefined {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "https:" || parsedUrl.protocol === "http:" || parsedUrl.protocol === "data:"
      ? parsedUrl
      : undefined;
  } catch {
    return undefined;
  }
}

function dataUrlToBase64(url: string): string {
  const match = /^data:image\/[^;,]+;base64,(.+)$/u.exec(url);
  if (!match) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像服务返回的 data URL 不受支持。", 502);
  }

  return match[1];
}

function isProviderImageContentType(value: string | null): boolean {
  if (!value) {
    return true;
  }

  const contentType = value.split(";")[0]?.trim().toLowerCase();
  return Boolean(contentType?.startsWith("image/") || contentType === "application/octet-stream");
}

function isProviderImageBytes(bytes: Buffer): boolean {
  return isPng(bytes) || isJpeg(bytes) || isWebp(bytes);
}

function isPng(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
}

function isWebp(bytes: Buffer): boolean {
  return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function dataUrlToFile(input: ReferenceImageInput): Promise<File> {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(input.dataUrl);
  if (!match) {
    throw new ProviderError("unsupported_provider_behavior", "参考图像格式不受支持。", 400);
  }

  const mimeType = match[1].toLowerCase();
  if (!SUPPORTED_REFERENCE_MIME_TYPES.has(mimeType)) {
    throw new ProviderError("unsupported_provider_behavior", "参考图像必须是 PNG、JPEG 或 WebP 格式。", 400);
  }

  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
    throw new ProviderError("unsupported_provider_behavior", "参考图像不能超过 50MB。", 400);
  }

  const normalizedMimeType = mimeType === "image/jpg" ? "image/jpeg" : mimeType;
  const extension = normalizedMimeType === "image/jpeg" ? "jpg" : normalizedMimeType.split("/")[1] || "png";
  const fileName = sanitizeFileName(input.fileName) ?? `reference.${extension}`;
  return toFile(bytes, fileName, { type: normalizedMimeType });
}

function sanitizeFileName(fileName: string | undefined): string | undefined {
  const trimmed = fileName?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/[^a-zA-Z0-9._-]/gu, "_");
}
