import type { GenerationTemplateType } from "@okouai/api-contracts/contracts/chat-threads";

import { parseAvatarTemplateStylePresetId } from "./avatar-template";
import { INTRO_VIDEO_TEMPLATE_ID } from "./intro-video-template";

/**
 * What one template selection actually produces.
 *
 * Three products share the wire contract's `type: "video"`: creative video,
 * talking avatar, and Intro Video. Only `selection.stylePresetId` tells them
 * apart, so every surface that names or buckets a selection was re-deriving
 * the same split from the raw id. This owns that derivation once.
 *
 * A kind is neither a display string nor a picker tab id. Callers translate it
 * into their own vocabulary: the composer's picker calls presentations
 * `"slides"`, and user-facing names come from i18n.
 */
export type GenerationTemplateKind =
  | "avatar"
  | "brand-motion"
  | "illustration"
  | "intro-video"
  | "presentation"
  | "video"
  | "website"
  | "workflow";

/**
 * The minimum a caller must expose to be classified.
 *
 * Structural instead of the full `GenerationTemplateRequest` so callers that
 * declare their own narrower selection union — the API's prompt builder — share
 * this derivation rather than copying it. `Exclude` keeps the non-video arms
 * tied to the wire contract, so a new wire `type` surfaces here as a type
 * error instead of silently classifying itself.
 */
export type GenerationTemplateKindSource =
  | {
      readonly type: "video";
      readonly selection: { readonly stylePresetId: string };
    }
  | { readonly type: Exclude<GenerationTemplateType, "video"> };

/**
 * Classify one template selection.
 *
 * Intro Video is checked before avatar because both are style-preset ids inside
 * the same envelope, and it is checked independently of
 * `selection.explainerOptions`: a selection whose settings are missing is still
 * an Intro Video selection, and reporting it as creative video would hide it.
 */
export function generationTemplateKind(
  source: GenerationTemplateKindSource,
): GenerationTemplateKind {
  if (source.type !== "video") {
    return source.type;
  }
  const { stylePresetId } = source.selection;
  if (stylePresetId === INTRO_VIDEO_TEMPLATE_ID) {
    return "intro-video";
  }
  return parseAvatarTemplateStylePresetId(stylePresetId) === undefined
    ? "video"
    : "avatar";
}
