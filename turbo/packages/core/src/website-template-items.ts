export interface WebsiteTemplateItem {
  readonly id: `website-template:${string}`;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly templateId: `template:${string}`;
  readonly previewUrl: string;
  readonly previewImageUrl: string;
}

// Curated user-facing website picker catalog backed by private R2
// packages.
const WEBSITE_TEMPLATE_PREVIEW_BASE_URL =
  "https://static.vm0.io/vm0/artifact-templates/website/website-studio-v2-20260727-ccff774";

export const WEBSITE_TEMPLATE_ITEMS: readonly WebsiteTemplateItem[] = [
  {
    id: "website-template:black-slabs",
    slug: "black-slabs",
    title: "Black Slabs",
    description:
      "High-contrast editorial website template with monolithic typography, full-bleed showcase panels, metric cards, and electric-indigo accents.",
    templateId: "template:black-slabs",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/black-slabs-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/black-slabs-preview-960x540.webp`,
  },
  {
    id: "website-template:blueprint-grid",
    slug: "blueprint-grid",
    title: "Blueprint Grid",
    description:
      "Blueprint-inspired website template with oversized uppercase type, mono labels, ruled editorial grids, and cobalt navigation details.",
    templateId: "template:blueprint-grid",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/blueprint-grid-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/blueprint-grid-preview-960x540.webp`,
  },
  {
    id: "website-template:coastal-hotel",
    slug: "coastal-hotel",
    title: "Coastal Hotel",
    description:
      "Hospitality website template with a crest-style hero, postcard cards, coastal contour details, hairline lists, and travel editorial motion.",
    templateId: "template:coastal-hotel",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/coastal-hotel-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/coastal-hotel-preview-960x540.webp`,
  },
  {
    id: "website-template:dot-matrix",
    slug: "dot-matrix",
    title: "Dot Matrix",
    description:
      "Kinetic website template with LED dot-matrix imagery, an oversized organic wordmark, numbered service indexing, and scrolling tag marquees.",
    templateId: "template:dot-matrix",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/dot-matrix-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/dot-matrix-preview-960x540.webp`,
  },
  {
    id: "website-template:frame-stack",
    slug: "frame-stack",
    title: "Frame Stack",
    description:
      "Architectural website template with full-bleed connected frames, coordinate labels, axon-style hero blocks, and stacked scroll sections.",
    templateId: "template:frame-stack",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/frame-stack-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/frame-stack-preview-960x540.webp`,
  },
  {
    id: "website-template:frosted-scatter",
    slug: "frosted-scatter",
    title: "Frosted Scatter",
    description:
      "Frosted-glass website template with scattered parallax photography, a flashlight grid cursor, line-by-line copy, and oversized numeric storytelling.",
    templateId: "template:frosted-scatter",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/frosted-scatter-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/frosted-scatter-preview-960x540.webp`,
  },
  {
    id: "website-template:gallery-wall",
    slug: "gallery-wall",
    title: "Gallery Wall",
    description:
      "Art-forward website template with cream canvas, painterly texture, framed artwork modules, accession labels, and serif editorial rhythm.",
    templateId: "template:gallery-wall",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/gallery-wall-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/gallery-wall-preview-960x540.webp`,
  },
  {
    id: "website-template:glass-bloom",
    slug: "glass-bloom",
    title: "Glass Bloom",
    description:
      "Soft glassmorphism website template with frosted panels, blooming gradient light, italic serif accents, and pinned device storytelling.",
    templateId: "template:glass-bloom",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/glass-bloom-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/glass-bloom-preview-960x540.webp`,
  },
  {
    id: "website-template:serif-stack",
    slug: "serif-stack",
    title: "Serif Stack",
    description:
      "Minimal serif website template with stacked cover sections, playful gravity tag clouds, scattered photos, and a characterful footer.",
    templateId: "template:serif-stack",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/serif-stack-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/serif-stack-preview-960x540.webp`,
  },
  {
    id: "website-template:sticker-pop",
    slug: "sticker-pop",
    title: "Sticker Pop",
    description:
      "Playful website template with sticker cards, outlined serif type, warm cream palette, circular imagery, and sticky story panels.",
    templateId: "template:sticker-pop",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/sticker-pop-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/sticker-pop-preview-960x540.webp`,
  },
  {
    id: "website-template:warm-cards",
    slug: "warm-cards",
    title: "Warm Cards",
    description:
      "Playful website template with a numbered color-block sidebar, soft full-screen cards, image-led hero, ticker content, and oversized footer wordmark.",
    templateId: "template:warm-cards",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/warm-cards-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/warm-cards-preview-960x540.webp`,
  },
];

export function findWebsiteTemplateItem(
  id: string,
): WebsiteTemplateItem | undefined {
  return WEBSITE_TEMPLATE_ITEMS.find((item) => {
    return item.id === id || item.slug === id || item.templateId === id;
  });
}
