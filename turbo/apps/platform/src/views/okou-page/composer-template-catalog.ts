// The composer's template catalog, shared by the template picker dialog and the
// slash panel. It owns the mapping from a catalog item to the generation
// template a message carries, so both surfaces select the same thing, and it
// derives the small preview model the slash panel renders.
import {
  DOCUMENT_TEMPLATE_ITEMS,
  type DocumentTemplateItem,
} from "@okouai/core/document-template-items";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  type IllustrationTemplateItem,
} from "@okouai/core/illustration-template-items";
import {
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  type PresentationTemplateItem,
} from "@okouai/core/presentation-template-items";
import {
  WEBSITE_TEMPLATE_ITEMS,
  type WebsiteTemplateItem,
} from "@okouai/core/website-template-items";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type { UserTemplateCatalogEntry } from "@okouai/api-contracts/contracts/user-templates";
import type { ComposerTemplateAttachment } from "../../signals/okou-page/tiptap-workflow-composer.ts";

export function defaultPresentationTemplateThemeId(
  item: PresentationTemplateItem,
): string {
  return item.colorSystemId.replace("color-system:", "");
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

export function toWebsiteGenerationTemplate(
  item: WebsiteTemplateItem,
): GenerationTemplateRequest {
  return {
    type: "website",
    selection: { websiteTemplateId: item.id },
  };
}

export function toDocumentGenerationTemplate(
  item: DocumentTemplateItem,
): GenerationTemplateRequest {
  return {
    type: "document",
    selection: { documentTemplateId: item.id },
  };
}

/**
 * The creation types the slash panel's Make group indexes. These are the template
 * picker's own categories, so opening the picker from a row lands on the same
 * tab.
 * Workflow is not one either — the panel lists the agent's own workflows right
 * underneath, so a row that only reopened the workflow catalog named the same
 * thing twice.
 */
export const SLASH_TEMPLATE_CATEGORIES = [
  "slides",
  "document",
  "illustration",
  "website",
] as const;

export type SlashTemplateCategory = (typeof SLASH_TEMPLATE_CATEGORIES)[number];

/** The catalogs that carry cover art, so they can fill a pane or a shelf. */
export type SlashTemplatePreviewCategory = SlashTemplateCategory;

/**
 * Covers render two across the 400px slash pane, about 180px each, and 200px
 * wide in the website shelf, so they are requested at 2x the wider of the two.
 */
const SLASH_TEMPLATE_COVER_SIZE = { width: 416, height: 234 } as const;

/**
 * Illustrations are asked for by width alone. The transform fits inside the box
 * it is given, so passing a 16:9 height as well shrank a 2:3 style to 105px
 * wide and the card then upscaled it. Width-only keeps the native proportion at
 * the resolution the card actually paints.
 */
const SLASH_TEMPLATE_NATIVE_COVER_SIZE = { width: 416 } as const;

/**
 * Categories whose covers keep their own proportion instead of the 16:9 tile.
 * An illustration *is* the artifact, and its catalog runs 20 portrait, 9 square
 * and 3 landscape, so a shared ratio would crop most of them — a 2:3 style
 * keeps only 37% of its height in a 16:9 box. A deck cover, by contrast, is a
 * slide and genuinely is 16:9.
 *
 * Documents are not here: every one is a portrait page, so they share one
 * ratio and keep the row-ordered grid (see `SLASH_DOCUMENT_COVER_ASPECT`).
 */
const SLASH_TEMPLATE_NATIVE_ASPECT_CATEGORIES = ["illustration"] as const;

/**
 * A document cover shows the head of its first page, as the picker's document
 * card does: a whole A4 page scaled into a 170px tile sets its title at about
 * five pixels, and two of them stood 240px tall in a pane the command list
 * holds near 194px, so not one caption was in view. The head is where the
 * format lives -- masthead, columns, a row of fields -- and 4:3 keeps a row of
 * covers and their names inside the pane.
 */
const SLASH_DOCUMENT_COVER_ASPECT = { width: 4, height: 3 } as const;

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
  readonly coverUrl: string | null;
  /**
   * The cover's own pixel proportion, for categories that render it uncropped.
   * Absent when the category uses the shared 16:9 tile.
   */
  readonly aspect?: { readonly width: number; readonly height: number };
  readonly template: GenerationTemplateRequest;
  readonly attachment: ComposerTemplateAttachment;
}

export function customSlashTemplatePreview(
  template: UserTemplateCatalogEntry,
): SlashTemplatePreview {
  return {
    slug: `custom:${template.id}`,
    title: template.title,
    coverUrl:
      template.kind === "illustration"
        ? (template.previewAssets[0]?.url ?? template.coverUrl)
        : template.coverUrl,
    ...(template.kind === "document"
      ? { aspect: SLASH_DOCUMENT_COVER_ASPECT }
      : template.kind === "illustration"
        ? { aspect: { width: 1, height: 1 } }
        : {}),
    template: {
      type: "custom",
      selection: { userTemplateId: template.id },
    },
    attachment: {
      type: "custom",
      title: template.title,
      category: template.kind === "presentation" ? "slides" : template.kind,
      ...(template.coverUrl === null || template.kind === "document"
        ? {}
        : { previewImageUrl: template.coverUrl }),
    },
  };
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
  const cover = coverUrl(item.cardPreviewImage);
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
  const cover = nativeCoverUrl(item.cardPreviewImage);
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

function documentPreview(item: DocumentTemplateItem): SlashTemplatePreview {
  return {
    slug: item.slug,
    title: item.title,
    coverUrl: nativeCoverUrl(item.previewImageUrl),
    aspect: SLASH_DOCUMENT_COVER_ASPECT,
    template: toDocumentGenerationTemplate(item),
    attachment: {
      type: "document",
      title: item.title,
      category: "document",
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
    case "document": {
      return DOCUMENT_TEMPLATE_ITEMS.map(documentPreview);
    }
    case "slides": {
      return PRESENTATION_TEMPLATE_PICKER_ITEMS.map(presentationPreview);
    }
    case "illustration": {
      return ILLUSTRATION_TEMPLATE_ITEMS.map(illustrationPreview);
    }
    case "website": {
      return WEBSITE_TEMPLATE_ITEMS.map(websitePreview);
    }
  }
}
