/**
 * HER — Image Model Registry
 *
 * Central, single-source-of-truth registry for all image generation models.
 * The UI, API route, and payload construction all derive from this config.
 *
 * To add a new model:
 *   1. Add its definition to IMAGE_MODELS below
 *   2. The UI and API route will automatically pick it up
 */

// ── Types ──────────────────────────────────────────────────

export type ImageModelMode = "create" | "edit";

export type AspectRatio = "1:1" | "4:5" | "3:4" | "16:9" | "9:16";

/** Controls that a model can optionally support */
export interface ImageModelCapabilities {
  prompt: boolean;
  width_height: boolean;
  aspect_ratio: boolean;
  steps: boolean;
  cfg_scale: boolean;
  negative_prompt: boolean;
  seed: boolean;
  image_input: boolean;
  /** Flux.1-dev requires mode:"base" in every payload */
  mode_field: boolean;
}

/** Numeric range constraint */
export interface Range {
  min: number;
  max: number;
}

/** Evidence-based stability rating from stress-test harness results */
export type ModelQuality = "stable" | "experimental" | "fast" | "specialized";

export interface ImageModelDef {
  id: string;
  label: string;
  description: string;
  /** Evidence-based stability hint (from harness 16O.3A results) */
  quality: ModelQuality;
  mode: ImageModelMode;
  endpoint: string;
  /**
   * Environment variable name for this model's API key.
   * Resolved at runtime via process.env[envKey].
   * Falls back to NVIDIA_IMAGE_API_KEY if the model-specific key is not set.
   */
  envKey: string;
  /** Default parameters — only includes keys the model supports */
  defaults: Record<string, unknown>;
  capabilities: ImageModelCapabilities;
  /** Safe numeric ranges for clamping */
  ranges: {
    steps?: Range;
    cfg_scale?: Range;
    seed?: Range;
  };
}

// ── Aspect Ratio → Width/Height Mapping ────────────────────

export const ASPECT_RATIO_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "1:1":  { width: 1024, height: 1024 },
  "4:5":  { width: 896,  height: 1120 },
  "3:4":  { width: 896,  height: 1152 },
  "16:9": { width: 1344, height: 768 },
  "9:16": { width: 768,  height: 1344 },
};

export const ASPECT_RATIOS: AspectRatio[] = ["1:1", "4:5", "3:4", "16:9", "9:16"];

// ── Model Registry ─────────────────────────────────────────

export const IMAGE_MODELS: ImageModelDef[] = [
  // ── CREATE models ────────────────────────────────────────
  {
    id: "flux-2-klein-4b",
    label: "Flux.2 Klein 4B",
    description: "Fast & crisp",
    quality: "fast",
    mode: "create",
    endpoint: "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b",
    envKey: "NVIDIA_FLUX2_KLEIN_API_KEY",
    defaults: {
      steps: 4,
      seed: 0,
      aspect_ratio: "1:1",
    },
    capabilities: {
      prompt: true,
      width_height: true,
      aspect_ratio: false,  // UI shows aspect ratio, but we map to w/h internally
      steps: true,
      cfg_scale: false,
      negative_prompt: false,
      seed: true,
      image_input: false,
      mode_field: false,
    },
    ranges: {
      steps: { min: 1, max: 4 },
      seed: { min: 0, max: 2147483647 },
    },
  },
  {
    id: "flux-1-dev",
    label: "Flux.1 Dev",
    description: "Highest control · can be slower",
    quality: "experimental",
    mode: "create",
    endpoint: "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev",
    envKey: "NVIDIA_FLUX1_DEV_API_KEY",
    defaults: {
      mode: "base",
      cfg_scale: 3.5,
      steps: 30,
      seed: 0,
      aspect_ratio: "1:1",
    },
    capabilities: {
      prompt: true,
      width_height: true,
      aspect_ratio: false,
      steps: true,
      cfg_scale: true,
      negative_prompt: false,
      seed: true,
      image_input: false,
      mode_field: true,
    },
    ranges: {
      steps: { min: 1, max: 50 },
      cfg_scale: { min: 1, max: 10 },
      seed: { min: 0, max: 2147483647 },
    },
  },
  {
    id: "stable-diffusion-3-medium",
    label: "Stable Diffusion 3",
    description: "Flexible classic",
    quality: "stable",
    mode: "create",
    endpoint: "https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3-medium",
    envKey: "NVIDIA_SD3_MEDIUM_API_KEY",
    defaults: {
      cfg_scale: 5,
      steps: 40,
      seed: 0,
      aspect_ratio: "1:1",
      negative_prompt: "",
    },
    capabilities: {
      prompt: true,
      width_height: false,
      aspect_ratio: true,  // SD3 accepts native aspect_ratio string
      steps: true,
      cfg_scale: true,
      negative_prompt: true,
      seed: true,
      image_input: false,
      mode_field: false,
    },
    ranges: {
      steps: { min: 1, max: 50 },
      cfg_scale: { min: 1, max: 15 },
      seed: { min: 0, max: 2147483647 },
    },
  },

  // ── EDIT model ───────────────────────────────────────────
  {
    id: "flux-1-kontext-dev",
    label: "Flux.1 Kontext",
    description: "Image-aware transformation",
    quality: "specialized",
    mode: "edit",
    endpoint: "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-kontext-dev",
    envKey: "NVIDIA_FLUX1_KONTEXT_API_KEY",
    defaults: {
      cfg_scale: 3.5,
      steps: 30,
      seed: 0,
      aspect_ratio: "match_input_image",
    },
    capabilities: {
      prompt: true,
      width_height: false,
      aspect_ratio: true,  // Supports aspect_ratio string including "match_input_image"
      steps: true,
      cfg_scale: true,
      negative_prompt: false,
      seed: true,
      image_input: true,
      mode_field: false,
    },
    ranges: {
      steps: { min: 1, max: 50 },
      cfg_scale: { min: 1, max: 10 },
      seed: { min: 0, max: 2147483647 },
    },
  },
];

// ── Helpers ────────────────────────────────────────────────

/** Default model for the "create" mode (backward compatible — SD3 was original) */
export const DEFAULT_CREATE_MODEL_ID = "stable-diffusion-3-medium";

/** Default model for the "edit" mode */
export const DEFAULT_EDIT_MODEL_ID = "flux-1-kontext-dev";

/** Find a model definition by ID. Returns undefined if not found. */
export function getImageModel(id: string): ImageModelDef | undefined {
  return IMAGE_MODELS.find((m) => m.id === id);
}

/** Get all models for a given mode */
export function getModelsByMode(mode: ImageModelMode): ImageModelDef[] {
  return IMAGE_MODELS.filter((m) => m.mode === mode);
}

/** Check if a model ID is valid and exists in registry */
export function isValidModelId(id: string): boolean {
  return IMAGE_MODELS.some((m) => m.id === id);
}

/** Check if the given aspect ratio is a valid standard option */
export function isValidAspectRatio(ratio: string): ratio is AspectRatio {
  return ASPECT_RATIOS.includes(ratio as AspectRatio);
}

/** Clamp a number to a range. Returns the default if value is not a finite number. */
export function clampToRange(value: unknown, range: Range, defaultValue: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
  // Preserve float precision — some models (e.g. Flux Kontext) are calibrated
  // for non-integer cfg_scale values like 3.5 and rounding to 4 pushes them
  // outside their tuned range.
  return Math.max(range.min, Math.min(range.max, value));
}

/**
 * Build the API payload for a given model and user params.
 * Only includes fields the model actually supports.
 * Falls back to model defaults for missing values.
 */
export function buildImagePayload(
  model: ImageModelDef,
  params: {
    prompt: string;
    aspect_ratio?: string;
    steps?: number;
    cfg_scale?: number;
    negative_prompt?: string;
    seed?: number;
    image?: string;
  }
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  // Prompt is always required
  payload.prompt = params.prompt;

  // mode:"base" for Flux.1-dev
  if (model.capabilities.mode_field) {
    payload.mode = "base";
  }

  // Aspect ratio / dimensions
  const ratioStr = params.aspect_ratio || (model.defaults.aspect_ratio as string) || "1:1";

  if (model.capabilities.width_height) {
    // Map aspect ratio to width/height
    const dims = isValidAspectRatio(ratioStr)
      ? ASPECT_RATIO_DIMENSIONS[ratioStr]
      : ASPECT_RATIO_DIMENSIONS["1:1"];
    payload.width = dims.width;
    payload.height = dims.height;
  } else if (model.capabilities.aspect_ratio) {
    // Send native aspect_ratio string
    if (model.mode === "edit" && params.image) {
      // Edit mode WITH a source image: always match the input dimensions.
      // Forcing a different aspect ratio (e.g. "1:1" on a non-square source)
      // makes Kontext's image-aware pipeline crash with a 500.
      payload.aspect_ratio = "match_input_image";
    } else if (model.mode === "edit") {
      // Edit mode with no image (shouldn't normally happen): pick a safe default.
      payload.aspect_ratio = isValidAspectRatio(ratioStr) ? ratioStr : "match_input_image";
    } else {
      payload.aspect_ratio = isValidAspectRatio(ratioStr) ? ratioStr : "1:1";
    }
  }

  // Steps
  if (model.capabilities.steps && model.ranges.steps) {
    payload.steps = clampToRange(
      params.steps,
      model.ranges.steps,
      model.defaults.steps as number
    );
  }

  // CFG Scale
  if (model.capabilities.cfg_scale && model.ranges.cfg_scale) {
    payload.cfg_scale = clampToRange(
      params.cfg_scale,
      model.ranges.cfg_scale,
      model.defaults.cfg_scale as number
    );
  }

  // Negative prompt — only include if non-empty
  if (model.capabilities.negative_prompt) {
    const neg = typeof params.negative_prompt === "string"
      ? params.negative_prompt.trim()
      : ((model.defaults.negative_prompt as string) ?? "").trim();
    if (neg.length > 0) {
      payload.negative_prompt = neg;
    }
  }

  // Seed — only include if model supports it AND the value is non-zero.
  // Several NVIDIA endpoints (notably Flux Kontext) reject `seed: 0` with a
  // 500. Treat 0 as "omit and let the provider pick".
  if (model.capabilities.seed && model.ranges.seed) {
    const seedVal = clampToRange(
      params.seed,
      model.ranges.seed,
      model.defaults.seed as number
    );
    if (typeof seedVal === "number" && Number.isFinite(seedVal) && seedVal > 0) {
      payload.seed = Math.floor(seedVal);
    }
  }

  // Image input (edit mode) — already normalized by caller
  if (model.capabilities.image_input && params.image) {
    payload.image = params.image;
  }

  return payload;
}

/**
 * Resolve the API key for a given model at runtime (server-side only).
 *
 * Resolution order:
 *   1. Model-specific env variable (e.g. NVIDIA_SD3_MEDIUM_API_KEY)
 *   2. Shared fallback: NVIDIA_IMAGE_API_KEY
 *
 * Returns the key string, or null if neither is set.
 */
export function resolveApiKey(model: ImageModelDef): string | null {
  // 1. Try model-specific key
  const specific = process.env[model.envKey];
  if (specific && specific.length > 0 && !specific.startsWith("your_")) {
    return specific;
  }

  // 2. Fallback to shared key
  const shared = process.env.NVIDIA_IMAGE_API_KEY;
  if (shared && shared.length > 0 && !shared.startsWith("your_")) {
    return shared;
  }

  return null;
}
