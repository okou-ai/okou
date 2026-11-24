// Catalog selections shared by the composer's recommendations and detail previews.
import type { DocumentTemplateItem } from "@okouai/core/document-template-items";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  type IllustrationTemplateItem,
} from "@okouai/core/illustration-template-items";
import type { PresentationTemplateItem } from "@okouai/core/presentation-template-items";
import {
  WEBSITE_TEMPLATE_ITEMS,
  type WebsiteTemplateItem,
} from "@okouai/core/website-template-items";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
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

function toIllustrationGenerationTemplate(
  item: IllustrationTemplateItem,
): GenerationTemplateRequest {
  return {
    type: "illustration",
    selection: {
      illustrationStyleId: item.illustrationStyleId,
    },
  };
}

function toWebsiteGenerationTemplate(
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

export type ComposerTemplatePreviewCategory = "illustration" | "website";

interface ComposerTemplatePreview {
  readonly slug: string;
  readonly title: string;
  readonly coverUrl: string;
  readonly template: GenerationTemplateRequest;
  readonly attachment: ComposerTemplateAttachment;
}

function illustrationPreview(
  item: IllustrationTemplateItem,
): ComposerTemplatePreview {
  // Width-only preserves portrait artwork before the recommendation tile crops it.
  const cover = r2ImageTransformUrl(item.cardPreviewImage, { width: 416 });
  return {
    slug: item.slug,
    title: item.title,
    coverUrl: cover,
    template: toIllustrationGenerationTemplate(item),
    attachment: {
      type: "illustration",
      title: item.title,
      category: "illustration",
      previewImageUrl: cover,
    },
  };
}

function websitePreview(item: WebsiteTemplateItem): ComposerTemplatePreview {
  return {
    slug: item.slug,
    title: item.title,
    coverUrl: r2ImageTransformUrl(item.previewImageUrl, {
      width: 416,
      height: 234,
    }),
    template: toWebsiteGenerationTemplate(item),
    attachment: {
      type: "website",
      title: item.title,
      category: "website",
    },
  };
}

/** The complete recommendation shelf, in curated catalog order. */
export function composerTemplatePreviews(
  category: ComposerTemplatePreviewCategory,
): readonly ComposerTemplatePreview[] {
  return category === "illustration"
    ? ILLUSTRATION_TEMPLATE_ITEMS.map(illustrationPreview)
    : WEBSITE_TEMPLATE_ITEMS.map(websitePreview);
}
