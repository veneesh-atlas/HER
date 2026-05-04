/**
 * HER — Image Model Router
 *
 * Pure, side-effect-free function that maps an image type to the best
 * model configuration for that type.
 *
 * Routing table:
 *   self_portrait   → Flux.1 Kontext (edit + reference image for consistency)
 *   creative        → Flux.1 Dev (highest control for artistic output)
 *   casual          → Flux.2 Klein 4B (fastest, good for everyday scenes)
 *   realistic_scene → Flux.1 Dev (proven hosted endpoint; SD3.5 Large is
 *                                 self-hosted-only on NVIDIA's catalog)
 */

export type ImageType =
  | "self_portrait"
  | "creative"
  | "casual"
  | "realistic_scene";

export interface RouteConfig {
  modelId: string;
  mode: "create" | "edit";
  /** Whether this route should use the HER reference image (Kontext edit mode) */
  useReferenceImage: boolean;
  /** Suggested parameter overrides for this route */
  overrides: {
    steps?: number;
    cfg_scale?: number;
    aspect_ratio?: string;
  };
}

/**
 * Map an image type + desired aspect ratio to the optimal model configuration.
 *
 * @param imageType - Classifier output image type (null falls back to Flux.1 Dev)
 * @param aspectRatio - Desired aspect ratio from the classifier
 */
export function routeImageType(
  imageType: ImageType | null,
  aspectRatio = "1:1"
): RouteConfig {
  switch (imageType) {
    case "self_portrait":
      return {
        modelId: "flux-1-kontext-dev",
        mode: "edit",
        useReferenceImage: true,
        overrides: {
          steps: 30,
          cfg_scale: 3.5,
          aspect_ratio: aspectRatio,
        },
      };

    case "creative":
      return {
        modelId: "flux-1-dev",
        mode: "create",
        useReferenceImage: false,
        overrides: {
          steps: 30,
          cfg_scale: 3.5,
          aspect_ratio: aspectRatio,
        },
      };

    case "casual":
      return {
        modelId: "flux-2-klein-4b",
        mode: "create",
        useReferenceImage: false,
        overrides: {
          steps: 4,
          aspect_ratio: aspectRatio,
        },
      };

    case "realistic_scene":
      break;
    default:
      // Unknown / unexpected image type from classifier — log so it's visible.
      if (imageType !== null) {
        console.warn(
          `[HER Router] Unknown image_type "${imageType}" — falling back to realistic_scene`
        );
      }
      break;
  }

  return {
    modelId: "flux-1-dev",
    mode: "create",
    useReferenceImage: false,
    overrides: {
      steps: 30,
      cfg_scale: 3.5,
      aspect_ratio: aspectRatio,
    },
  };
}
