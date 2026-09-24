export interface VideoTemplateItem {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly previewImage: string;
  readonly cardPreviewImage?: string;
  readonly previewVideo: string;
  readonly previewWebm: string;
}

const VIDEO_TEMPLATE_PREVIEW_IMAGES: Readonly<Record<string, string>> = {
  "chinese-ink-art":
    "https://static.vm0.io/vm0/artifact-templates/video/35a45e0a-095f-476c-9586-840b3e591947/thumbnail-chinese-ink-art.jpg",
  "cyberpunk-anime":
    "https://static.vm0.io/vm0/artifact-templates/video/b870f6c1-95a8-4ab6-aa0d-a125cb57dd3e/thumbnail-cyberpunk-anime.jpg",
  "epic-grandeur":
    "https://static.vm0.io/vm0/artifact-templates/video/2c0eb943-f65a-4225-beaa-78246f7c4a1b/thumbnail-imax-epic-cinematic.jpg",
  "fashion-editorial":
    "https://static.vm0.io/vm0/artifact-templates/video/31026908-c354-4cb5-a51b-8ac8e12ac910/thumbnail-fashion-editorial.jpg",
  "gourmet-documentary":
    "https://static.vm0.io/vm0/artifact-templates/video/30ab1733-bec0-4ddb-9e15-8f707377af7b/thumbnail-gourmet-documentary.jpg",
  "hand-drawn-fantasy-anime":
    "https://static.vm0.io/vm0/artifact-templates/video/ad08022e-5b28-4e80-a67f-cbe5d27cbc03/thumbnail-hand-drawn-fantasy-anime.jpg",
  "japanese-wabi-sabi":
    "https://static.vm0.io/vm0/artifact-templates/video/a7a69fe3-9e6c-48fd-af55-62c8a57a0371/thumbnail-japanese-wabi-sabi.jpg",
  "luxury-product":
    "https://static.vm0.io/vm0/artifact-templates/video/016fd6d1-05d9-4709-a7d8-0799409fa1d9/thumbnail-luxury-watch-product.jpg",
  "shortform-viral":
    "https://static.vm0.io/vm0/artifact-templates/video/40ab801f-16bc-4e29-8370-6b10cd394e30/thumbnail-shortform-viral.jpg",
  "sports-performance-ad":
    "https://static.vm0.io/vm0/artifact-templates/video/5a95669a-b86c-4817-9d82-250da7509b54/thumbnail-athletic-motivation.jpg",
};

const VIDEO_TEMPLATE_CARD_PREVIEW_IMAGES: Readonly<Record<string, string>> = {
  "epic-grandeur":
    "https://static.vm0.io/vm0/artifact-templates/video/9ad13726-9151-4c68-b89d-afbe90c949bb/template-card-video-epic-grandeur-480x270.jpg",
  "gourmet-documentary":
    "https://static.vm0.io/vm0/artifact-templates/video/37cffe87-de56-4a53-bddc-b8f43f97b260/template-card-video-gourmet-documentary-480x270.jpg",
  "luxury-product":
    "https://static.vm0.io/vm0/artifact-templates/video/9726e1d9-f08e-4a94-b823-2b1f89bc382d/template-card-video-luxury-product-480x270.jpg",
  "shortform-viral":
    "https://static.vm0.io/vm0/artifact-templates/video/2d798f24-325f-4185-9a01-28b3faa3950f/template-card-video-shortform-viral-480x270.jpg",
  "fashion-editorial":
    "https://static.vm0.io/vm0/artifact-templates/video/fa629d39-bf4f-433c-ad87-7385aa05700b/template-card-video-fashion-editorial-480x270.jpg",
  "sports-performance-ad":
    "https://static.vm0.io/vm0/artifact-templates/video/91cf5878-1b6f-468c-82e1-4d59a99fccae/template-card-video-sports-performance-ad-480x270.jpg",
  "japanese-wabi-sabi":
    "https://static.vm0.io/vm0/artifact-templates/video/07d4529e-d9ed-43dd-bf13-c2f6ac253476/template-card-video-japanese-wabi-sabi-480x270.jpg",
  "hand-drawn-fantasy-anime":
    "https://static.vm0.io/vm0/artifact-templates/video/82204005-e01a-47de-9120-e533e992b290/template-card-video-hand-drawn-fantasy-anime-480x270.jpg",
  "cyberpunk-anime":
    "https://static.vm0.io/vm0/artifact-templates/video/1d690a29-2be1-404b-9698-638f18685513/template-card-video-cyberpunk-anime-480x270.jpg",
  "chinese-ink-art":
    "https://static.vm0.io/vm0/artifact-templates/video/0bad21ee-4b92-4ea0-ad15-5453573aad7b/template-card-video-chinese-ink-art-480x270.jpg",
};

const VIDEO_TEMPLATE_PREVIEW_VIDEOS: Readonly<Record<string, string>> = {
  "chinese-ink-art":
    "https://static.vm0.io/vm0/artifact-templates/video/8314b0ae-6051-4daa-b789-51bec466ba66/video-8314b0ae.mp4",
  "cyberpunk-anime":
    "https://static.vm0.io/vm0/artifact-templates/video/e1cfe984-3bfc-4ba1-acb3-9b40b7b76771/video-e1cfe984.mp4",
  "epic-grandeur":
    "https://static.vm0.io/vm0/artifact-templates/video/df99de74-8eea-420c-86d1-c104ba5ba6b6/video-df99de74.mp4",
  "fashion-editorial":
    "https://static.vm0.io/vm0/artifact-templates/video/8bf8b826-2517-435b-8882-7f071c683e46/video-8bf8b826.mp4",
  "gourmet-documentary":
    "https://static.vm0.io/vm0/artifact-templates/video/3f0dd8d7-bfc3-4443-9b95-b58faf0d4f64/video-3f0dd8d7.mp4",
  "hand-drawn-fantasy-anime":
    "https://static.vm0.io/vm0/artifact-templates/video/da7c7c2d-3383-4796-8e83-b0e112127387/video-da7c7c2d.mp4",
  "japanese-wabi-sabi":
    "https://static.vm0.io/vm0/artifact-templates/video/72b754cf-f76d-4fa9-9015-ab5082b49608/video-72b754cf.mp4",
  "luxury-product":
    "https://static.vm0.io/vm0/artifact-templates/video/9e20abbb-a630-4523-857f-8350eba2ea4f/video-9e20abbb.mp4",
  "shortform-viral":
    "https://static.vm0.io/vm0/artifact-templates/video/4bac1319-dba7-47a0-bc1b-4d1e932f71fd/video-4bac1319.mp4",
  "sports-performance-ad":
    "https://static.vm0.io/vm0/artifact-templates/video/104ad36a-4d0c-472b-8416-d04cc2f06e75/video-104ad36a.mp4",
};

const VIDEO_TEMPLATE_PREVIEW_WEBMS: Readonly<Record<string, string>> = {
  "chinese-ink-art":
    "https://static.vm0.io/vm0/artifact-templates/video/b18f8d3e-22c9-468f-817e-2046d134fcf6/chinese-ink-art.webm",
  "cyberpunk-anime":
    "https://static.vm0.io/vm0/artifact-templates/video/cf8ab683-7c7e-4cfd-b9f2-44eec893407e/cyberpunk-anime.webm",
  "epic-grandeur":
    "https://static.vm0.io/vm0/artifact-templates/video/e8b67299-f944-4942-a727-931026dea2a0/epic-grandeur.webm",
  "fashion-editorial":
    "https://static.vm0.io/vm0/artifact-templates/video/51e93c96-03be-4d5a-a66c-b90ec6c52111/fashion-editorial.webm",
  "gourmet-documentary":
    "https://static.vm0.io/vm0/artifact-templates/video/3b39aeed-30be-4e79-8a6a-23ffd76fca86/gourmet-documentary.webm",
  "hand-drawn-fantasy-anime":
    "https://static.vm0.io/vm0/artifact-templates/video/42f6fb38-6544-4e42-ba4d-5dd352da9051/hand-drawn-fantasy-anime.webm",
  "japanese-wabi-sabi":
    "https://static.vm0.io/vm0/artifact-templates/video/22d6c8cb-b7f0-40f7-9c5f-022e578a060b/japanese-wabi-sabi.webm",
  "luxury-product":
    "https://static.vm0.io/vm0/artifact-templates/video/1ad1c730-d146-4bf5-9936-dea198c593ec/luxury-product.webm",
  "shortform-viral":
    "https://static.vm0.io/vm0/artifact-templates/video/0b1dbbb8-782e-451d-87e9-6652f60116bf/shortform-viral.webm",
  "sports-performance-ad":
    "https://static.vm0.io/vm0/artifact-templates/video/a6dab950-dddc-4116-9bc3-624265b35c12/sports-performance-ad.webm",
};

// Display metadata for immutable chat history. Retired templates are never
// offered by the resource registry, composer, onboarding, or generation API.
const RETIRED_VIDEO_TEMPLATES = [
  {
    slug: "epic-grandeur",
    title: "Epic Grandeur",
    description:
      "Large-format epic cinematic video style with wide framing, aerial scale, golden backlight, and awe-struck tone.",
  },
  {
    slug: "gourmet-documentary",
    title: "Gourmet Documentary",
    description:
      "Sensory culinary-documentary video style with macro food texture, steam, warm backlight, and artisan hands.",
  },
  {
    slug: "luxury-product",
    title: "Luxury Product Macro",
    description:
      "Dark luxury product macro video style with premium material detail, black studio, pinpoint highlights, and refined reveals.",
  },
  {
    slug: "shortform-viral",
    title: "Shortform Viral",
    description:
      "Short-form viral video style with vertical framing, fast hook, handheld creator energy, bright color, and quick rhythm.",
  },
  {
    slug: "fashion-editorial",
    title: "Fashion Editorial",
    description:
      "High-fashion editorial video style with cold desaturated grade, strong silhouettes, luxury texture, and deliberate pose.",
  },
  {
    slug: "sports-performance-ad",
    title: "Sports Performance Ad",
    description:
      "Sports performance advertising video style with athlete effort, gear close-ups, impact rhythm, and dramatic rim light.",
  },
  {
    slug: "japanese-wabi-sabi",
    title: "Japanese Wabi-Sabi",
    description:
      "Japanese wabi-sabi lifestyle video style with natural imperfection, warm soft light, negative space, and quiet mood.",
  },
  {
    slug: "hand-drawn-fantasy-anime",
    title: "Hand Drawn Fantasy Anime",
    description:
      "Hand-drawn fantasy animation video style with painterly 2D backgrounds, expressive characters, and gentle wonder.",
  },
  {
    slug: "cyberpunk-anime",
    title: "Cyberpunk Anime",
    description:
      "2D cyberpunk anime video style with neon megacity atmosphere, rain-slick streets, cel shading, and melancholic mood.",
  },
  {
    slug: "chinese-ink-art",
    title: "Chinese Ink Painting",
    description:
      "Chinese ink-wash video style with monochrome brush texture, white space, mist, and calm classical-poetry mood.",
  },
] as const;

function toVideoTemplateItem(
  entry: (typeof RETIRED_VIDEO_TEMPLATES)[number],
): VideoTemplateItem {
  const { slug, title, description } = entry;
  const id = `video-template:${slug}`;
  const previewImage = VIDEO_TEMPLATE_PREVIEW_IMAGES[slug];
  const cardPreviewImage = VIDEO_TEMPLATE_CARD_PREVIEW_IMAGES[slug];
  const previewVideo = VIDEO_TEMPLATE_PREVIEW_VIDEOS[slug];
  const previewWebm = VIDEO_TEMPLATE_PREVIEW_WEBMS[slug];
  if (!previewImage || !cardPreviewImage || !previewVideo || !previewWebm) {
    throw new Error(`Missing historical video template preview: ${id}`);
  }
  return {
    id,
    slug,
    title,
    description,
    previewImage,
    cardPreviewImage,
    previewVideo,
    previewWebm,
  };
}

/** Historical display metadata; not an available template catalog. */
export const VIDEO_TEMPLATE_ITEMS: readonly VideoTemplateItem[] =
  RETIRED_VIDEO_TEMPLATES.map(toVideoTemplateItem);

const RETIRED_VIDEO_TEMPLATE_ALIASES: Readonly<Record<string, string>> = {
  "athletic-motivation": "sports-performance-ad",
  "imax-epic-cinematic": "epic-grandeur",
  "luxury-watch-product": "luxury-product",
};

export function findVideoTemplateItem(
  id: string,
): VideoTemplateItem | undefined {
  const slug = id.replace(/^video-template:/u, "");
  const canonicalSlug = RETIRED_VIDEO_TEMPLATE_ALIASES[slug] ?? slug;
  return VIDEO_TEMPLATE_ITEMS.find((item) => {
    return item.slug === canonicalSlug;
  });
}
