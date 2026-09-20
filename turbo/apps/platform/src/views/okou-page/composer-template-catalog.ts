// The composer's template catalog, shared by the template picker dialog and the
// slash panel. It owns the mapping from a catalog item to the generation
// template a message carries, so both surfaces select the same thing, and it
// derives the small preview model the slash panel renders.
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  type IllustrationTemplateItem,
} from "@okouai/core/illustration-template-items";
import {
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  type PresentationTemplateItem,
} from "@okouai/core/presentation-template-items";
import {
  VIDEO_TEMPLATE_ITEMS,
  type VideoTemplateItem,
} from "@okouai/core/video-template-items";
import {
  WEBSITE_TEMPLATE_ITEMS,
  type WebsiteTemplateItem,
} from "@okouai/core/website-template-items";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type { ComposerTemplateAttachment } from "../../signals/okou-page/tiptap-workflow-composer.ts";

/** Falls back to the stylesheet's own default when an item pins no system. */
export function defaultPresentationTemplateThemeId(
  item: PresentationTemplateItem,
): string {
  return item.colorSystemId?.replace("color-system:", "") ?? "warm-sand";
}

export function presentationTemplateColorSystemId(themeId: string): string {
  return `color-system:${themeId}`;
}

export function toPresentationGenerationTemplate(
  item: PresentationTemplateItem,
  colorSystemId = presentationTemplateColorSystemId(
    defaultPresentationTemplateThemeId(item),
  ),
): GenerationTemplateRequest {
  return {
    type: "presentation",
    selection: {
      templateId: item.templateId,
      colorSystemId,
      previewUrl: item.embedUrl,
    },
  };
}

export function toIllustrationGenerationTemplate(
  item: IllustrationTemplateItem,
): GenerationTemplateRequest {
  return {
    type: "illustration",
    selection: {
      illustrationStyleId: item.illustrationStyleId,
    },
  };
}

/**
 * Text-to-video styles, not the talking-avatar options that share the "video"
 * envelope.
 */
export function toVideoGenerationTemplate(
  item: VideoTemplateItem,
): GenerationTemplateRequest {
  return {
    type: "video",
    selection: {
      stylePresetId: item.id,
    },
  };
}

export function toWebsiteGenerationTemplate(
  item: WebsiteTemplateItem,
): GenerationTemplateRequest {
  return {
    type: "website",
    selection: { websiteTemplateId: item.id },
  };
}

/**
 * The three things the slash panel's Make group indexes. These are the template
 * picker's own categories, so opening the picker from a row lands on the same
 * tab. Video is not one of them: its catalog is reached from the picker itself.
 * Workflow is not one either — the panel lists the agent's own workflows right
 * underneath, so a row that only reopened the workflow catalog named the same
 * thing twice.
 */
export const SLASH_TEMPLATE_CATEGORIES = [
  "slides",
  "illustration",
  "website",
] as const;

export type SlashTemplateCategory = (typeof SLASH_TEMPLATE_CATEGORIES)[number];

/**
 * The catalogs that carry cover art, so they can fill a pane or a shelf of
 * them. `video` stays in the union because the task chips' shelf is typed over
 * every create mode, not because a surface still previews it; the note on
 * `VIDEO_IDEAS` in `composer-task-chips.tsx` records what reaches that shelf.
 */
export type SlashTemplatePreviewCategory =
  | "slides"
  | "illustration"
  | "video"
  | "website";

/** Covers render two across a 320px pane, so they are requested at 2x that. */
const SLASH_TEMPLATE_COVER_SIZE = { width: 280, height: 158 } as const;

/**
 * Illustrations are asked for by width alone. The transform fits inside the box
 * it is given, so passing a 16:9 height as well shrank a 2:3 style to 105px
 * wide and the card then upscaled it. Width-only keeps the native proportion at
 * the resolution the card actually paints.
 */
const SLASH_TEMPLATE_NATIVE_COVER_SIZE = { width: 280 } as const;

/**
 * Categories whose covers keep their own proportion instead of the 16:9 tile.
 * An illustration *is* the artifact, and its catalog runs 20 portrait, 9 square
 * and 3 landscape, so a shared ratio would crop most of them — a 2:3 style
 * keeps only 37% of its height in a 16:9 box. A deck cover, by contrast, is a
 * slide and genuinely is 16:9.
 */
const SLASH_TEMPLATE_NATIVE_ASPECT_CATEGORIES = ["illustration"] as const;

export function isSlashTemplateNativeAspectCategory(
  category: SlashTemplatePreviewCategory,
): boolean {
  return SLASH_TEMPLATE_NATIVE_ASPECT_CATEGORIES.some((candidate) => {
    return candidate === category;
  });
}

export interface SlashTemplatePreview {
  readonly slug: string;
  readonly title: string;
  readonly coverUrl: string;
  /**
   * The cover's own pixel proportion, for categories that render it uncropped.
   * Absent when the category uses the shared 16:9 tile.
   */
  readonly aspect?: { readonly width: number; readonly height: number };
  readonly template: GenerationTemplateRequest;
  readonly attachment: ComposerTemplateAttachment;
}

function coverUrl(source: string): string {
  return r2ImageTransformUrl(source, SLASH_TEMPLATE_COVER_SIZE);
}

function nativeCoverUrl(source: string): string {
  return r2ImageTransformUrl(source, SLASH_TEMPLATE_NATIVE_COVER_SIZE);
}

function presentationPreview(
  item: PresentationTemplateItem,
): SlashTemplatePreview {
  // `cardPreviewImage` is already the item's default color system, which is the
  // one a fresh selection uses.
  const cover = coverUrl(item.cardPreviewImage ?? item.previewImage);
  return {
    slug: item.slug,
    title: item.title,
    coverUrl: cover,
    template: toPresentationGenerationTemplate(item),
    attachment: {
      type: "presentation",
      title: item.title,
      category: "slides",
      previewImageUrl: cover,
    },
  };
}

function illustrationPreview(
  item: IllustrationTemplateItem,
): SlashTemplatePreview {
  const cover = nativeCoverUrl(item.cardPreviewImage ?? item.previewImage);
  return {
    slug: item.slug,
    title: item.title,
    coverUrl: cover,
    aspect: { width: item.width, height: item.height },
    template: toIllustrationGenerationTemplate(item),
    attachment: {
      type: "illustration",
      title: item.title,
      category: "illustration",
      previewImageUrl: cover,
    },
  };
}

function videoPreview(item: VideoTemplateItem): SlashTemplatePreview {
  return {
    slug: item.slug,
    title: item.title,
    coverUrl: coverUrl(item.cardPreviewImage ?? item.previewImage),
    template: toVideoGenerationTemplate(item),
    // Video and website chips carry no cover in the composer today; the panel
    // shows the poster frame without changing what the chip stores.
    attachment: {
      type: "video",
      title: item.title,
      category: "video",
    },
  };
}

function websitePreview(item: WebsiteTemplateItem): SlashTemplatePreview {
  return {
    slug: item.slug,
    title: item.title,
    coverUrl: coverUrl(item.previewImageUrl),
    template: toWebsiteGenerationTemplate(item),
    attachment: {
      type: "website",
      title: item.title,
      category: "website",
    },
  };
}

/**
 * The whole category, in catalog order — the same curated order the picker
 * dialog leads with, since the client has no usage signal to rank by. Both
 * surfaces that render these scroll, and the slash pane heads them with the
 * category's size, so carrying only the first screenful left the covers
 * disagreeing with the count they sit under.
 */
export function slashTemplatePreviews(
  category: SlashTemplatePreviewCategory,
): readonly SlashTemplatePreview[] {
  switch (category) {
    case "slides": {
      return PRESENTATION_TEMPLATE_PICKER_ITEMS.map(presentationPreview);
    }
    case "illustration": {
      return ILLUSTRATION_TEMPLATE_ITEMS.map(illustrationPreview);
    }
    case "video": {
      return VIDEO_TEMPLATE_ITEMS.map(videoPreview);
    }
    case "website": {
      return WEBSITE_TEMPLATE_ITEMS.map(websitePreview);
    }
  }
}
