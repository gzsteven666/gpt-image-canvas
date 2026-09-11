import {
  ProviderError,
  createOpenAIImageProvider,
  type OpenAIImageProviderConfig,
  type ImageProvider
} from "../../infrastructure/providers/image-provider.js";
import {
  getEnvironmentOpenAIImageProviderConfig,
  getLocalOpenAIImageProviderConfig,
  getProviderSourceOrder
} from "./provider-config.js";
import type { ProviderSourceId, RuntimeImageProvider } from "../contracts.js";

export interface ConfiguredImageProviderSelection {
  sourceId: ProviderSourceId;
  provider: RuntimeImageProvider;
  openAIConfig?: OpenAIImageProviderConfig;
}

export async function createConfiguredImageProvider(signal?: AbortSignal): Promise<ImageProvider> {
  const selection = await selectConfiguredImageProviderSource(signal);

  if (selection?.openAIConfig) {
    console.info(
      `[image-provider] selected ${selection.sourceId} (${selection.provider}) baseURL=${selection.openAIConfig.baseURL ?? "official"} model=${selection.openAIConfig.model}`
    );
    return createOpenAIImageProvider(selection.openAIConfig);
  }

  throw new ProviderError(
    "missing_provider",
    "服务器没有配置 OPENAI_API_KEY。请先配置 OpenAI 兼容图片接口后重试。",
    401
  );
}

export async function selectConfiguredImageProviderSource(
  signal?: AbortSignal
): Promise<ConfiguredImageProviderSelection | undefined> {
  void signal;

  for (const sourceId of getProviderSourceOrder()) {
    if (sourceId === "env-openai") {
      const openAIConfig = getEnvironmentOpenAIImageProviderConfig();
      if (openAIConfig) {
        return {
          sourceId,
          provider: "openai",
          openAIConfig
        };
      }
      continue;
    }

    if (sourceId === "local-openai") {
      const openAIConfig = getLocalOpenAIImageProviderConfig();
      if (openAIConfig) {
        return {
          sourceId,
          provider: "openai",
          openAIConfig
        };
      }
      continue;
    }

  }

  return undefined;
}
