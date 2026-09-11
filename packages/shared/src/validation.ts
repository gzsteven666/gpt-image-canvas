import {
  CUSTOM_SIZE_PRESET_ID,
  SIZE_PRESETS,
  type AspectRatioPreset,
  type ImageSize,
  type ImageSizePresetId,
  type ResolutionPreset,
  type ResolvedImageSize
} from "./image.js";

export type ValidationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      code: string;
      message: string;
      reason?: ImageSizeValidationReason;
    };

export type ImageSizeValidationReason =
  | "non_integer"
  | "too_small"
  | "too_large"
  | "not_multiple"
  | "aspect_ratio"
  | "total_pixels_too_small"
  | "total_pixels_too_large"
  | "unsupported_preset";

export type ImageSizeValidationResult =
  | {
      ok: true;
      size: ImageSize;
      apiValue: string;
      source: "preset" | "custom";
      presetId?: ImageSizePresetId;
    }
  | {
      ok: false;
      code: "invalid_size" | "invalid_size_preset";
      message: string;
      reason?: ImageSizeValidationReason;
    };

export const MIN_IMAGE_DIMENSION = 512;
export const MAX_IMAGE_DIMENSION = 3840;
export const IMAGE_SIZE_MULTIPLE = 16;
export const MIN_TOTAL_PIXELS = 655_360;
export const MAX_TOTAL_PIXELS = 8_294_400;
export const MAX_IMAGE_ASPECT_RATIO = 3;

export function validateImageSize(size: ImageSize): ValidationResult {
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height)) {
    return { ok: false, code: "invalid_size", reason: "non_integer", message: "宽度和高度必须是整数。" };
  }
  if (size.width < MIN_IMAGE_DIMENSION || size.height < MIN_IMAGE_DIMENSION) {
    return { ok: false, code: "invalid_size", reason: "too_small", message: `宽度和高度不能小于 ${MIN_IMAGE_DIMENSION}px。` };
  }
  if (size.width > MAX_IMAGE_DIMENSION || size.height > MAX_IMAGE_DIMENSION) {
    return { ok: false, code: "invalid_size", reason: "too_large", message: `宽度和高度不能大于 ${MAX_IMAGE_DIMENSION}px。` };
  }
  if (size.width % IMAGE_SIZE_MULTIPLE !== 0 || size.height % IMAGE_SIZE_MULTIPLE !== 0) {
    return { ok: false, code: "invalid_size", reason: "not_multiple", message: `宽度和高度必须是 ${IMAGE_SIZE_MULTIPLE}px 的倍数。` };
  }
  if (Math.max(size.width, size.height) / Math.min(size.width, size.height) > MAX_IMAGE_ASPECT_RATIO) {
    return { ok: false, code: "invalid_size", reason: "aspect_ratio", message: `长边和短边比例不能超过 ${MAX_IMAGE_ASPECT_RATIO}:1。` };
  }
  if (size.width * size.height < MIN_TOTAL_PIXELS) {
    return {
      ok: false,
      code: "invalid_size",
      reason: "total_pixels_too_small",
      message: `总像素不能小于 ${MIN_TOTAL_PIXELS.toLocaleString()}。`
    };
  }
  if (size.width * size.height > MAX_TOTAL_PIXELS) {
    return {
      ok: false,
      code: "invalid_size",
      reason: "total_pixels_too_large",
      message: `总像素不能超过 ${MAX_TOTAL_PIXELS.toLocaleString()}。`
    };
  }
  return { ok: true };
}

export function sizeToApiValue(size: ImageSize): string {
  return `${size.width}x${size.height}`;
}

function alignDimension(value: number): number {
  return Math.max(IMAGE_SIZE_MULTIPLE, Math.round(value / IMAGE_SIZE_MULTIPLE) * IMAGE_SIZE_MULTIPLE);
}

function sizeFromLongSide(aspectRatio: AspectRatioPreset, longSide: number): ImageSize {
  if (aspectRatio.widthRatio >= aspectRatio.heightRatio) {
    return {
      width: alignDimension(longSide),
      height: alignDimension((longSide * aspectRatio.heightRatio) / aspectRatio.widthRatio)
    };
  }

  return {
    width: alignDimension((longSide * aspectRatio.widthRatio) / aspectRatio.heightRatio),
    height: alignDimension(longSide)
  };
}

export function resolveImageSizeFromAspectResolution(
  aspectRatio: AspectRatioPreset,
  resolution: ResolutionPreset
): ResolvedImageSize {
  const requestedSize = sizeFromLongSide(aspectRatio, resolution.longSide);
  const requestedValidation = validateImageSize(requestedSize);

  if (requestedValidation.ok) {
    return {
      size: requestedSize,
      requestedSize,
      adjusted: false
    };
  }

  const shouldScaleDown =
    requestedValidation.reason === "too_large" || requestedValidation.reason === "total_pixels_too_large";
  const step = shouldScaleDown ? -IMAGE_SIZE_MULTIPLE : IMAGE_SIZE_MULTIPLE;
  const boundary = shouldScaleDown ? MIN_IMAGE_DIMENSION : MAX_IMAGE_DIMENSION;

  for (
    let longSide = Math.max(MIN_IMAGE_DIMENSION, Math.min(MAX_IMAGE_DIMENSION, resolution.longSide + step));
    shouldScaleDown ? longSide >= boundary : longSide <= boundary;
    longSide += step
  ) {
    const nextSize = sizeFromLongSide(aspectRatio, longSide);
    if (validateImageSize(nextSize).ok) {
      return {
        size: nextSize,
        requestedSize,
        adjusted: true
      };
    }
  }

  return {
    size: requestedSize,
    requestedSize,
    adjusted: true
  };
}

export function validateSceneImageSize(input: {
  size: ImageSize;
  sizePresetId?: string | null;
}): ImageSizeValidationResult {
  const requestedPresetId = input.sizePresetId?.trim();
  const requestedPreset =
    requestedPresetId && requestedPresetId !== CUSTOM_SIZE_PRESET_ID
      ? SIZE_PRESETS.find((preset) => preset.id === requestedPresetId)
      : undefined;

  if (requestedPresetId && requestedPresetId !== CUSTOM_SIZE_PRESET_ID && !requestedPreset) {
    return {
      ok: false,
      code: "invalid_size_preset",
      reason: "unsupported_preset",
      message: "不支持的场景尺寸预设。"
    };
  }

  const sizeValidation = validateImageSize(input.size);
  if (!sizeValidation.ok) {
    return {
      ok: false,
      code: "invalid_size",
      reason: sizeValidation.reason,
      message: sizeValidation.message
    };
  }

  const matchingPreset = SIZE_PRESETS.find(
    (preset) => preset.width === input.size.width && preset.height === input.size.height
  );

  return {
    ok: true,
    size: input.size,
    apiValue: sizeToApiValue(input.size),
    source: matchingPreset ? "preset" : "custom",
    presetId: matchingPreset?.id ?? CUSTOM_SIZE_PRESET_ID
  };
}
