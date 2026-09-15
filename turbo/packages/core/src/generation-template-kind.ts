import type { GenerationTemplateType } from "@okouai/api-contracts/contracts/chat-threads";

import { parseAvatarTemplateStylePresetId } from "./avatar-template";

/**
 * What one template selection actually produces.
 *
 * Creative video and talking avatar still share the wire contract's
 * `type: "video"` and are told apart only by `selection.stylePresetId`, so this
 * owns that derivation once rather than leaving each surface to re-read the raw
 * id. Every other product, Intro Video included, is its own wire type and
 * passes straight through.
 *
 * A kind is neither a display string nor a picker tab id. Callers translate it
 * into their own vocabulary: the composer's picker calls presentations
 * `"slides"`, and user-facing names come from i18n.
 */
export type GenerationTemplateKind =
  | "avatar"
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
 * A selection stored before Intro Video became its own wire type still carries
 * `type: "video"`, so it classifies as creative video. That is the accepted
 * cost of not backfilling staff-only rows; see the Intro Video schema in
 * `chat-threads.ts`.
 */
export function generationTemplateKind(
  source: GenerationTemplateKindSource,
): GenerationTemplateKind {
  if (source.type !== "video") {
    return source.type;
  }
  return parseAvatarTemplateStylePresetId(source.selection.stylePresetId) ===
    undefined
    ? "video"
    : "avatar";
}
