import type { GenerationTemplateType } from "@okouai/api-contracts/contracts/chat-threads";

import { parseAvatarTemplateStylePresetId } from "./avatar-template";

/**
 * What one template selection actually produces.
 *
 * Creative video and talking avatar still share the wire contract's
 * `type: "video"` and are told apart only by `selection.stylePresetId`, so this
 * owns that derivation once rather than leaving each surface to re-read the raw
 * id. Every other product is its own wire type and passes straight through.
 *
 * A kind is neither a display string nor a picker tab id. Callers translate it
 * into their own vocabulary: the composer's picker calls presentations
 * `"slides"`, and user-facing names come from i18n.
 */
export type GenerationTemplateKind =
  | "avatar"
  | "custom"
  | "illustration"
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
 * A retired Intro Video selection reports as creative video. Its rows survive
 * in the append-only chat event log, and the wire type is the only thing left
 * of the product, so it is folded into the envelope it came from rather than
 * kept as a kind no surface can render. This matches how selections stored
 * before Intro Video had its own wire type already classify.
 */
export function generationTemplateKind(
  source: GenerationTemplateKindSource,
): GenerationTemplateKind {
  if (source.type === "intro-video") {
    return "video";
  }
  if (source.type !== "video") {
    return source.type;
  }
  return parseAvatarTemplateStylePresetId(source.selection.stylePresetId) ===
    undefined
    ? "video"
    : "avatar";
}
