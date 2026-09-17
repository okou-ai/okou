import {
  WEBSITE_TEMPLATE_ITEMS,
  findWebsiteTemplateItem,
  type WebsiteTemplateItem,
} from "./website-template-items";
import {
  PRESENTATION_IMAGE_BATCH_INSTRUCTION,
  PRESENTATION_STATIC_HTML_INSTRUCTION,
} from "./presentation-generation-instructions";
import {
  PRESENTATION_REVERSE_TEMPLATE_ARCHIVE_SHA256,
  PRESENTATION_REVERSE_TEMPLATE_RESOURCE_ID,
  PRESENTATION_REVERSE_TEMPLATE_RESOURCE_PATH,
} from "./presentation-reverse-template-resource";

export type GenerationTarget =
  | "image"
  | "presentation"
  | "website"
  | "dashboard-design"
  | "mobile-app-design"
  | "poster"
  | "intro-video"
  | "report"
  | "docs-design";

export type GenerationOutputKind =
  | "website"
  | "image"
  | "audio"
  | "video"
  | "presentation"
  | "report"
  | "poster"
  | "dashboard-design"
  | "mobile-app-design"
  | "docs-design"
  | "bundle";

type ResourceKind =
  | "skill"
  | "tool"
  | "template"
  | "design-system"
  | "color-system"
  | "image-style"
  | "audio-style"
  | "video-template"
  | "bundle-template";

interface ResourceSourceRef {
  readonly path: string;
  readonly repo?: string;
  readonly ref?: string;
  readonly archive?: {
    readonly type: "tar.gz";
    readonly sha256: string;
  };
}

export interface RegistryEntry {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly name: string;
  readonly description: string;
  readonly desc?: string;
  readonly source: ResourceSourceRef;
  /**
   * Generation targets this entry applies to. Mandatory for `kind: "skill"`
   * and `kind: "template"` so we can filter them per `generate` subcommand.
   * Optional and unused for other kinds — design systems apply to all HTML
   * targets, image styles apply only to image generation, and so on.
   */
  readonly targets?: readonly GenerationTarget[];
}

export interface VideoTemplateRegistryEntry extends Omit<
  RegistryEntry,
  "kind" | "source"
> {
  readonly kind: "video-template";
  readonly source: ResourceSourceRef & {
    readonly repo: string;
    readonly ref: string;
  };
}

export interface ResourceCandidateSlice {
  readonly registryVersion: string;
  /** Pinned Git source for every candidate without `source.archive`. */
  readonly source: {
    readonly repo: string;
    readonly ref: string;
  };
  readonly candidates: {
    readonly skills: readonly RegistryEntry[];
    readonly templates: readonly RegistryEntry[];
    readonly designSystems: readonly RegistryEntry[];
  };
}

const RESOURCE_REGISTRY_REPO = "nexu-io/open-design";
const RESOURCE_REGISTRY_COMMIT = "3fb620af423534643677c7c6fae76be088fa770a";
const SKILLS_REPO = "vm0-ai/vm0-skills";
const SKILLS_REF = "main";
const VIDEO_TEMPLATE_REGISTRY_SOURCE = {
  repo: SKILLS_REPO,
  ref: SKILLS_REF,
} as const;

export const RESOURCE_REGISTRY_VERSION = "v1";

function privateR2ArchiveSource(
  path: string,
  sha256: string,
): ResourceSourceRef & {
  readonly archive: NonNullable<ResourceSourceRef["archive"]>;
} {
  return {
    path,
    archive: {
      type: "tar.gz",
      sha256,
    },
  };
}

// Pinned archive digests for image style packages. Keep these aligned with
// the private R2 version ids served by the API download route.
const IMAGE_STYLE_ARCHIVE_SHA256: Readonly<Record<string, string>> = {
  "emboss-deboss":
    "f1c1be0b1cf711a8c61945f928206d700b54d71969711f0551403d20c360d3f8",
  "cozy-parlor":
    "c68f23536a0bd16e2d25b41dc77eb8a7e0ef798bcd10de614697ce73ea20205d",
  "crowd-ink":
    "db3938a80247c6407755671d15116d99ef09190289d1af854f64443769528939",
  "editorial-flatfolk":
    "f4f4fba414e5f816393f545fc8ee2157e6fc8b19781dd4016e0ed4100f97881a",
  endpaper: "f43a0e3b9a093132e9cb87569c0daee4cef571434454a64c1eca2c7d586fb041",
  "flat-poster":
    "6bd75a94d11e1a5c56169cd509948170b1b2c8abeb3cd1b5edbdfe2fd5e0b83f",
  "folk-muse":
    "9f5cd9168a952d0596942382134b9170a80fc51429bf2a027ae73229d1ad9b37",
  "folk-storybook":
    "3685d6f4f71e76b25ebb7ef3b15b16e18c4ae167cbd9855272d3fbe8f0597ee4",
  "grain-poster":
    "ba19d4a6362b329dbc8c5c3e813d28f7ead5db617ce29efffe6a5709e9d4c3e9",
  "grainy-duotone":
    "17341a1b4f2a62e601ad3ccdcd5610dc72e8f51eb275fdb23370164e61f98c1b",
  "iberian-vignette":
    "8cf1dc409f64d7d5760787e4a9f60c3d9ff4488847cfed8de57be2e64f0bfc08",
  "ink-mascot":
    "b9ab95fa3b6612daea88e7313a14843731eb27daabc3740dcc8e85ec5a7247d0",
  "ink-storefront":
    "40b65c731e46f35633fbd18fada81ed2fabebc6d88d521917d4859ce469a4af4",
  inkdab: "5389733d7cbd35be4cfe060e2e5df4163f1be718a4a2e1486876bf604f089f4e",
  inkstomp: "70b9605babab9947a77b1bd2efa2130cb69fd4813423b0ccf8fa36b25b77a18a",
  "iso-scene":
    "6f1ab27d0558125d0ae9e3e72341560d8cd7928dd361dd9ece37c06c241e6175",
  "jade-blockprint":
    "42ad01d6ed018892fb54c9aa6017c68c70b148219a29640afa29ad74e8c757da",
  "light-pop-portrait":
    "eea5f691547e524eba32b7f6f5493d6b0e2d908483a1ac1665dc344e53583923",
  "loose-contour":
    "2be2ad6955ee3de42e669ec8d7ccba6f0b7461ff6ff2b07c495461f57749d46a",
  "mellow-pop":
    "58cbc5d4a9a6096a05107071670b8ae3c9e20a0706b228fc654f33a5936c940b",
  "mosaic-still-life":
    "f68d69a25cc686faa7d2d876d91726ff00ecd22f70ddeb53eec460d2682ea797",
  "notion-illustration":
    "fd074314a1cc1da0433711da1515e85c1e31e34b393cd66b819e2cf6329a592e",
  "op-ed-cover":
    "89f47e7be124c17c9750a7fc5495c0a189b96dc204cdedc38b24cc834e9c02a6",
  "painterly-botanical":
    "bca8b9a428cfdc0d3a64466a421367964234d779e209c2e4bfb9a68db8507ce9",
  papernook: "ef45679989582b781dd629bb5aa0822941e82c1aad0ee8ae435da8e8541c694f",
  "postcard-illustration":
    "707dce8362b3d9f28134172ad063861f523fbc66a69109eee8c4a2b00936bd1e",
  "riso-relic":
    "a2ca7fdcb2c389690edb4227f51fab59139b35603c1718327780a1de61997ed7",
  "shadow-pop":
    "446a1071b82359dbad3d895edc3dc00bc593bca7ada327b45806a23bb2a7ee21",
  "soft-vector":
    "7720ac2645bf69091241eb7b1010be7df21e2d1a56d49047526dd4d51bab0c76",
  "sticker-sheet":
    "2765eaeed3959c08a0cd9143aa709ffe7b0ff3023b04776aa6ccd09d912c866d",
  "sunlit-gouache":
    "fea806daab5589d1370356d6f90cecb676b79ac0f2ee6390d0ad12217cd8ea9b",
  "tiny-wanderer":
    "03b1f744718f5b2444ea7e90f1e141771c0960516f4ebf6bd31bf80551e3b714",
  "vm0-illustration":
    "03e77d6968190b9f1888a900963135e92f75b40a6c37e1c1bae999ea49669a37",
};

function imageStyleArchiveSha256(slug: string): string {
  const sha256 = IMAGE_STYLE_ARCHIVE_SHA256[slug];
  if (!sha256) {
    throw new Error(`Missing image style archive sha256 for ${slug}`);
  }
  return sha256;
}

function imageStyleSource(slug: string): ResourceSourceRef {
  return {
    repo: SKILLS_REPO,
    ref: SKILLS_REF,
    path: `illustration-template/${slug}`,
    archive: {
      type: "tar.gz",
      sha256: imageStyleArchiveSha256(slug),
    },
  };
}

const PRESENTATION_RESOURCE_ARCHIVE_SHA256 = {
  colorSystemBauhausPrimary:
    "f42a1d62462f24b1a411889f8011b07bd3f1bb1db82a339cc59cf5ab5be2f475",
  colorSystemBerryPop:
    "dfb63401d8991e2cc54acb2489eee937bce7e890991a2cc3a102447f39ed5539",
  colorSystemCarnival:
    "70d3721484929f0c841da5b0ecdb81889e81b5f37280607889c532cee1183f48",
  colorSystemCitrusFresh:
    "776e5e0f57f85b1896fe52cf9bc31a72a6e3a5e2f6629f5538abee022474b757",
  colorSystemCoralStudio:
    "d3a6f57fe02ac67530c005b011771dc48366155c537c35a04ed1c76d56d37b39",
  colorSystemForestEditorial:
    "359ebe14d8d3b3bd45a669402ef5f97223a67029e2ee6c6bab9f54af8a143ea6",
  colorSystemGoldLuxe:
    "0f9cabcf693ad4b6266bbaec2a4ec723a8292b759b8e342b180b79e48b485843",
  colorSystemMauveDusk:
    "de5abb4063c7abdba91efc3be2522130b51fe9bc1def51aa7fa05f3529b08588",
  colorSystemMidnightMono:
    "45db0976a10c24eede57bb38502d8a7d8ec5ad44456f32276d9b590760bb3875",
  colorSystemMintTech:
    "e66358f8ab1b8cb243a26540711add2343ede056b5218706074bbc75bc1089bc",
  colorSystemMonoInk:
    "851fc5dbf70fb4811362f6899ded96639e828b2efa82ae6ed716b4265eee712a",
  colorSystemNordicFrost:
    "b4d4920ec93bb39ddb7b9650f1c67567fdc4d19573011d573da14cb58e61e4d2",
  colorSystemOceanDeep:
    "b189e1454eb91bbf951753edf2cf9bd6a4e0317573dcb7b7bf002a9fef7165db",
  colorSystemPopArt:
    "076a4d943611abd05c1e2f5e2936901da38dbdf0b36f46aa7268e82f74b0a0af",
  colorSystemPrism:
    "059e0754eefc8bc2a49c3332ddabf65d8edb7d306d6d697929b367dbe2ea4768",
  colorSystemSlateCorporate:
    "4d8b502cb6ade2ec0490cfe9652e2c21477c2c67d5785f512135ba1b51694a13",
  colorSystemSunsetMaroon:
    "f57b3b2bc079f9c81d7cb6e394d0f3f098e3f971258de0dc6d3670e034c66467",
  colorSystemTerracottaClay:
    "f174828c51f50a0f8c6c91493920e232f16ba6ec8c08dd9a0f896aaade9fadee",
  colorSystemWarmSand:
    "b76919f0c5a3fe0a72586938e79eea81d90b6ab09701f7bef3fe9f50b94d757b",
} as const;

function videoTemplateSource(
  path: string,
): VideoTemplateRegistryEntry["source"] {
  return {
    ...VIDEO_TEMPLATE_REGISTRY_SOURCE,
    path,
  };
}

const VIDEO_TEMPLATE_REGISTRY: readonly VideoTemplateRegistryEntry[] = [
  {
    id: "video-template:epic-grandeur",
    kind: "video-template",
    name: "Epic Grandeur",
    description:
      "Large-format epic cinematic video style with wide framing, aerial scale, golden backlight, and awe-struck tone.",
    source: videoTemplateSource("video-template/epic-grandeur"),
  },
  {
    id: "video-template:gourmet-documentary",
    kind: "video-template",
    name: "Gourmet Documentary",
    description:
      "Sensory culinary-documentary video style with macro food texture, steam, warm backlight, and artisan hands.",
    source: videoTemplateSource("video-template/gourmet-documentary"),
  },
  {
    id: "video-template:luxury-product",
    kind: "video-template",
    name: "Luxury Product Macro",
    description:
      "Dark luxury product macro video style with premium material detail, black studio, pinpoint highlights, and refined reveals.",
    source: videoTemplateSource("video-template/luxury-product"),
  },
  {
    id: "video-template:shortform-viral",
    kind: "video-template",
    name: "Shortform Viral",
    description:
      "Short-form viral video style with vertical framing, fast hook, handheld creator energy, bright color, and quick rhythm.",
    source: videoTemplateSource("video-template/shortform-viral"),
  },
  {
    id: "video-template:fashion-editorial",
    kind: "video-template",
    name: "Fashion Editorial",
    description:
      "High-fashion editorial video style with cold desaturated grade, strong silhouettes, luxury texture, and deliberate pose.",
    source: videoTemplateSource("video-template/fashion-editorial"),
  },
  {
    id: "video-template:sports-performance-ad",
    kind: "video-template",
    name: "Sports Performance Ad",
    description:
      "Sports performance advertising video style with athlete effort, gear close-ups, impact rhythm, and dramatic rim light.",
    source: videoTemplateSource("video-template/sports-performance-ad"),
  },
  {
    id: "video-template:japanese-wabi-sabi",
    kind: "video-template",
    name: "Japanese Wabi-Sabi",
    description:
      "Japanese wabi-sabi lifestyle video style with natural imperfection, warm soft light, negative space, and quiet mood.",
    source: videoTemplateSource("video-template/japanese-wabi-sabi"),
  },
  {
    id: "video-template:hand-drawn-fantasy-anime",
    kind: "video-template",
    name: "Hand Drawn Fantasy Anime",
    description:
      "Hand-drawn fantasy animation video style with painterly 2D backgrounds, expressive characters, and gentle wonder.",
    source: videoTemplateSource("video-template/hand-drawn-fantasy-anime"),
  },
  {
    id: "video-template:cyberpunk-anime",
    kind: "video-template",
    name: "Cyberpunk Anime",
    description:
      "2D cyberpunk anime video style with neon megacity atmosphere, rain-slick streets, cel shading, and melancholic mood.",
    source: videoTemplateSource("video-template/cyberpunk-anime"),
  },
  {
    id: "video-template:chinese-ink-art",
    kind: "video-template",
    name: "Chinese Ink Painting",
    description:
      "Chinese ink-wash video style with monochrome brush texture, white space, mist, and calm classical-poetry mood.",
    source: videoTemplateSource("video-template/chinese-ink-art"),
  },
];

// These targets mirror each skill's `od.mode` in the pinned Open Design commit.
const OPEN_DESIGN_SKILL_TARGETS = {
  prototype: [
    "website",
    "dashboard-design",
    "mobile-app-design",
    "poster",
    "report",
    "docs-design",
  ],
  deck: ["presentation"],
  image: ["image", "poster"],
  video: ["intro-video"],
  template: ["intro-video"],
  "design-system": [],
} as const satisfies Record<
  "prototype" | "deck" | "image" | "video" | "template" | "design-system",
  readonly GenerationTarget[]
>;

const RESOURCE_REGISTRY: readonly RegistryEntry[] = [
  {
    id: "skill:article-magazine",
    kind: "skill",
    name: "Article Magazine",
    description:
      "Shapes research or editorial material into a magazine-like narrative with strong hierarchy.",
    source: { path: "skills/article-magazine/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:design-brief",
    kind: "skill",
    name: "Design Brief",
    description:
      "Converts a product, brand, or feature request into a structured design brief.",
    source: { path: "skills/design-brief/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:8-bit-orbit-video-template",
    kind: "skill",
    name: "8 Bit Orbit Video Template",
    description:
      "HyperFrames-based video template for retro pixel deck motion design — multi-scene HTML-to-video composition with advanced transitions and ready-to-render default style.",
    source: { path: "skills/8-bit-orbit-video-template/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.template,
  },
  {
    id: "skill:after-hours-editorial-template",
    kind: "skill",
    name: "After Hours Editorial Template",
    description:
      "Luxury dark-editorial HyperFrames template for three-page cinematic storyboards — haute couture title cards and magazine chapter spreads with moody serif-led storytelling.",
    source: { path: "skills/after-hours-editorial-template/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.template,
  },
  {
    id: "skill:algorithmic-art",
    kind: "skill",
    name: "Algorithmic Art",
    description:
      "Create generative art using p5.js with seeded randomness so every render is reproducible. Useful for procedural posters, motion-style stills, and artistic frame studies.",
    source: { path: "skills/algorithmic-art/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.image,
  },
  {
    id: "skill:apple-hig",
    kind: "skill",
    name: "Apple HIG",
    description:
      "Apple Human Interface Guidelines as 14 agent skills covering platforms, foundations, components, patterns, inputs, and technologies for iOS, macOS, visionOS, watchOS, and tvOS.",
    source: { path: "skills/apple-hig/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:brainstorming",
    kind: "skill",
    name: "Brainstorming",
    description:
      "Transform rough ideas into fully-formed designs through structured questioning and alternative exploration. Useful early in concept work.",
    source: { path: "skills/brainstorming/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:brand-guidelines",
    kind: "skill",
    name: "Brand Guidelines",
    description:
      "Apply Anthropic's official brand colors and typography to artifacts for consistent visual identity and professional design standards. A reference for shaping your own.",
    source: { path: "skills/brand-guidelines/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:canvas-design",
    kind: "skill",
    name: "Canvas Design",
    description:
      "Create beautiful visual art in PNG and PDF documents using design philosophy and aesthetic principles for posters, illustrations, and static pieces.",
    source: { path: "skills/canvas-design/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.image,
  },
  {
    id: "skill:card-twitter",
    kind: "skill",
    name: "Card Twitter",
    description: "Twitter quote or data card designed to pair with a post.",
    source: { path: "skills/card-twitter/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:card-xiaohongshu",
    kind: "skill",
    name: "Card Xiaohongshu",
    description:
      "Xiaohongshu-style knowledge cards, arranged as a swipeable multi-card carousel.",
    source: { path: "skills/card-xiaohongshu/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:color-expert",
    kind: "skill",
    name: "Color Expert",
    description:
      "Color science expert skill with 286K words of reference material covering OKLCH/OKLAB, palette generation, accessibility/contrast, color naming, pigment mixing, and historical color theory.",
    source: { path: "skills/color-expert/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:creative-director",
    kind: "skill",
    name: "Creative Director",
    description:
      "AI creative director with recursive self-assessment: 20+ methodologies (SIT, TRIZ, Bisociation, SCAMPER, Synectics), 3-axis evaluation calibrated against Cannes/D&AD/HumanKind, 5-phase process from brief to presentation.",
    source: { path: "skills/creative-director/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:d3-visualization",
    kind: "skill",
    name: "D3 Visualization",
    description:
      "Teaches the agent to produce D3 charts and interactive data visualizations. Useful for editorial dashboards, reports, and explanatory graphics.",
    source: { path: "skills/d3-visualization/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:deck-guizang-editorial",
    kind: "skill",
    name: "Deck Guizang Editorial",
    description:
      "Editorial magazine meets e-ink: 10 layouts and 5 palettes (Ink, Indigo Porcelain, Forest Ink, Kraft Paper, Dune).",
    source: { path: "skills/deck-guizang-editorial/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.deck,
  },
  {
    id: "skill:deck-open-slide-canvas",
    kind: "skill",
    name: "Deck Open Slide Canvas",
    description:
      "Locked 1920x1080 canvas deck with React component-level free composition, not bound to a fixed template.",
    source: { path: "skills/deck-open-slide-canvas/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.deck,
  },
  {
    id: "skill:deck-swiss-international",
    kind: "skill",
    name: "Deck Swiss International",
    description:
      "16-column grid, one saturated accent, and 22 locked layouts (Klein Blue, Lemon, Mint, Safety Orange).",
    source: { path: "skills/deck-swiss-international/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.deck,
  },
  {
    id: "skill:design-consultation",
    kind: "skill",
    name: "Design Consultation",
    description:
      "Build a complete design system from scratch with creative risks and realistic product mockups. Useful for kickoff workshops and brand-from-zero work.",
    source: { path: "skills/design-consultation/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:design-md",
    kind: "skill",
    name: "Design MD",
    description:
      "Create and manage DESIGN.md files. Useful for capturing design direction, tokens, and visual rules in a single source of truth.",
    source: { path: "skills/design-md/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:design-review",
    kind: "skill",
    name: "Design Review",
    description:
      "Designer Who Codes: visual audit then fixes with atomic commits and before/after screenshots. Useful for tightening shipped UI before launch.",
    source: { path: "skills/design-review/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:digits-fintech-swiss-template",
    kind: "skill",
    name: "Digits Fintech Swiss Template",
    description:
      "Swiss-grid fintech deck template in black / warm paper / neon-lime — strict modular layout, bold numeric cards, restrained motion, keyboard/click navigation.",
    source: { path: "skills/digits-fintech-swiss-template/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.template,
  },
  {
    id: "skill:doc-kami-parchment",
    kind: "skill",
    name: "DOC Kami Parchment",
    description:
      "Warm parchment canvas (#f5f4ed), monochrome ink-blue accent (#1B365D), one serif family, and editorial-grade typography.",
    source: { path: "skills/doc-kami-parchment/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:editorial-burgundy-principles-template",
    kind: "skill",
    name: "Editorial Burgundy Principles Template",
    description:
      "Editorial studio deck template in burgundy / blush / muted-gold — pill tags, large typographic statements, principle cards, guided keyboard/click navigation.",
    source: { path: "skills/editorial-burgundy-principles-template/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.template,
  },
  {
    id: "skill:enhance-prompt",
    kind: "skill",
    name: "Enhance Prompt",
    description:
      "Improve prompts with design specs and UI/UX vocabulary. Useful for design-to-code workflows and clarifying requests for visual output.",
    source: { path: "skills/enhance-prompt/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:faq-page",
    kind: "skill",
    name: "FAQ Page",
    description:
      "A Frequently Asked Questions (FAQ) page with collapsible accordion sections, search functionality, and category filtering.",
    source: { path: "skills/faq-page/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:field-notes-editorial-template",
    kind: "skill",
    name: "Field Notes Editorial Template",
    description:
      "Editorial Field Notes report template — soft paper background, serif hero typography, rounded pastel insight cards, retention chart panel. Premium magazine-style.",
    source: { path: "skills/field-notes-editorial-template/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.template,
  },
  {
    id: "skill:figma-create-design-system-rules",
    kind: "skill",
    name: "Figma Create Design System Rules",
    description:
      "Generate project-specific design system rules for Figma-to-code workflows. Useful for capturing tokens, naming, and lint rules in one source.",
    source: { path: "skills/figma-create-design-system-rules/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:figma-generate-design",
    kind: "skill",
    name: "Figma Generate Design",
    description:
      "Build or update screens in Figma from code or description using design system components. Translate app pages into Figma using design tokens.",
    source: { path: "skills/figma-generate-design/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:figma-generate-library",
    kind: "skill",
    name: "Figma Generate Library",
    description:
      "Build or update a professional-grade design system library in Figma from a codebase. Useful for keeping the Figma source of truth in sync with shipped components.",
    source: { path: "skills/figma-generate-library/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:figma-implement-design",
    kind: "skill",
    name: "Figma Implement Design",
    description:
      "Translate Figma designs into production-ready code with 1:1 visual fidelity. Useful for handing off Figma frames straight to a frontend agent.",
    source: { path: "skills/figma-implement-design/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:flutter-animating-apps",
    kind: "skill",
    name: "Flutter Animating Apps",
    description:
      "Implement animated effects, transitions, and motion in Flutter apps. Useful for native iOS/Android motion design.",
    source: { path: "skills/flutter-animating-apps/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:frame-data-chart-nyt",
    kind: "skill",
    name: "Frame Data Chart Nyt",
    description:
      "NYT-newsroom typography, staggered reveal animation, and editorial-grade charts (line, bar, or range band).",
    source: { path: "skills/frame-data-chart-nyt/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.video,
  },
  {
    id: "skill:frame-flowchart-sticky",
    kind: "skill",
    name: "Frame Flowchart Sticky",
    description:
      "SVG curve connectors, sticky-note nodes, and cursor interaction with a whiteboard-brainstorm feel.",
    source: { path: "skills/frame-flowchart-sticky/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.video,
  },
  {
    id: "skill:frame-glitch-title",
    kind: "skill",
    name: "Frame Glitch Title",
    description:
      "Digital glitch, chromatic offset, and data-corruption title frame for video transitions or cyberpunk heroes.",
    source: { path: "skills/frame-glitch-title/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.video,
  },
  {
    id: "skill:frame-light-leak-cinema",
    kind: "skill",
    name: "Frame Light Leak Cinema",
    description:
      "Film light leaks, grain, 16:9 letterbox, and large serif type for cinematic openings or chapter cards.",
    source: { path: "skills/frame-light-leak-cinema/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.video,
  },
  {
    id: "skill:frame-liquid-bg-hero",
    kind: "skill",
    name: "Frame Liquid Bg Hero",
    description:
      "WebGL-style fluid displacement background with a quote overlay, suited to video intros, landing heroes, or posters.",
    source: { path: "skills/frame-liquid-bg-hero/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.video,
  },
  {
    id: "skill:frame-logo-outro",
    kind: "skill",
    name: "Frame Logo Outro",
    description:
      "Segmented logo assembly, glow bloom, and tagline reveal for video outros or brand closing frames.",
    source: { path: "skills/frame-logo-outro/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.video,
  },
  {
    id: "skill:frame-macos-notification",
    kind: "skill",
    name: "Frame Macos Notification",
    description:
      "Realistic macOS notification banner with app icon, title, and body, suited to video overlays or product teasers.",
    source: { path: "skills/frame-macos-notification/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.video,
  },
  {
    id: "skill:frontend-design",
    kind: "skill",
    name: "Frontend Design",
    description:
      "Frontend design and UI/UX development tools for shipping production-ready interfaces with strong typographic and layout discipline.",
    source: { path: "skills/frontend-design/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:frontend-dev",
    kind: "skill",
    name: "Frontend Dev",
    description:
      "Full-stack frontend with cinematic animations, AI-generated media via MiniMax API, and generative art. Useful for hero pages and showcase sites.",
    source: { path: "skills/frontend-dev/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:frontend-skill",
    kind: "skill",
    name: "Frontend Skill",
    description:
      "Create visually strong landing pages, websites, and app UIs with restrained composition. OpenAI's production frontend playbook.",
    source: { path: "skills/frontend-skill/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:frontend-slides",
    kind: "skill",
    name: "Frontend Slides",
    description:
      "Generate animation-rich HTML presentations with visual style previews. Useful for online keynotes, embedded talks, and interactive briefs.",
    source: { path: "skills/frontend-slides/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.deck,
  },
  {
    id: "skill:gsap-core",
    kind: "skill",
    name: "GSAP Core",
    description:
      "Core GSAP API with gsap.to(), from(), fromTo(), easing, duration, stagger, and defaults. Production-grade web animation primitives.",
    source: { path: "skills/gsap-core/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:gsap-react",
    kind: "skill",
    name: "GSAP React",
    description:
      "GSAP React integration with useGSAP hook, refs, gsap.context(), cleanup, and SSR. Ships safe motion in React + Next.js apps.",
    source: { path: "skills/gsap-react/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:gsap-scrolltrigger",
    kind: "skill",
    name: "GSAP Scrolltrigger",
    description:
      "GSAP ScrollTrigger for scroll-linked animations, pinning, scrub, and refresh handling. Useful for editorial sites and product pages.",
    source: { path: "skills/gsap-scrolltrigger/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:gsap-timeline",
    kind: "skill",
    name: "GSAP Timeline",
    description:
      "GSAP Timelines with sequencing, position parameter, labels, nesting, and playback control. Useful for orchestrating multi-step motion sequences.",
    source: { path: "skills/gsap-timeline/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:hand-drawn-diagrams",
    kind: "skill",
    name: "Hand Drawn Diagrams",
    description:
      "Generate hand-drawn Excalidraw diagrams from a prompt - animated SVG, hosted edit link, and PNG export. Works with Claude Code, Codex, Gemini CLI, and any agent supporting standard skill paths.",
    source: { path: "skills/hand-drawn-diagrams/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:hatch-pet",
    kind: "skill",
    name: "Hatch Pet",
    description:
      "Create, repair, validate, preview, and package Codex-compatible animated pet spritesheets with an 8x9 atlas, QA contact sheets, preview videos, and pet.json packaging.",
    source: { path: "skills/hatch-pet/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.image,
  },
  {
    id: "skill:html-ppt-retro-quarterly-review",
    kind: "skill",
    name: "HTML PPT Retro Quarterly Review",
    description:
      "Retro Quarterly Review template — bold blue + orange editorial with slab headlines, cream paper sections, structured grids, fast premium motion pacing in video mode.",
    source: { path: "skills/html-ppt-retro-quarterly-review/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.template,
  },
  {
    id: "skill:login-flow",
    kind: "skill",
    name: "Login Flow",
    description: "Mobile login and authentication flow screens.",
    source: { path: "skills/login-flow/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:mockup-device-3d",
    kind: "skill",
    name: "Mockup Device 3D",
    description:
      "Static iPhone and MacBook 3D-style showcase with real HTML embedded on screens, glass-lens refraction, and 360-degree turntable composition.",
    source: { path: "skills/mockup-device-3d/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:paywall-upgrade-cro",
    kind: "skill",
    name: "Paywall Upgrade Cro",
    description:
      "Design and optimize upgrade screens, paywalls, and upsell modals. Useful for SaaS conversion design and pricing-page experiments.",
    source: { path: "skills/paywall-upgrade-cro/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:plan-design-review",
    kind: "skill",
    name: "Plan Design Review",
    description:
      "Senior Designer review: rates each design dimension 0-10, explains what a 10 looks like, and flags AI Slop signals. Useful as a gate before merging UI work.",
    source: { path: "skills/plan-design-review/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:platform-design",
    kind: "skill",
    name: "Platform Design",
    description:
      "300+ design rules from Apple HIG, Material Design 3, and WCAG 2.2 for cross-platform apps. Useful when shipping a single design across iOS, Android, and the web.",
    source: { path: "skills/platform-design/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:poster-hero",
    kind: "skill",
    name: "Poster Hero",
    description:
      "Vertical poster or Moments-style share image with strong visual impact.",
    source: { path: "skills/poster-hero/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:ppt-keynote",
    kind: "skill",
    name: "PPT Keynote",
    description:
      "Apple Keynote-quality slides, one card per screen, with keyboard left/right navigation.",
    source: { path: "skills/ppt-keynote/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.deck,
  },
  {
    id: "skill:release-notes-one-pager",
    kind: "skill",
    name: "Release Notes One Pager",
    description:
      'Release notes one-page HTML with highlights, Added, Fixed, Breaking changes, Known issues, and Upgrade note. Writes explicit "None" style sections whenever the user does not provide details.',
    source: { path: "skills/release-notes-one-pager/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:resume-modern",
    kind: "skill",
    name: "Resume Modern",
    description:
      "Modern minimal resume, single A4 page, ready for print or PDF export.",
    source: { path: "skills/resume-modern/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:screenshots-marketing",
    kind: "skill",
    name: "Screenshots Marketing",
    description:
      "Generate marketing screenshots with Playwright. Useful for landing-page hero shots, App Store screenshots, and changelog visuals.",
    source: { path: "skills/screenshots-marketing/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.image,
  },
  {
    id: "skill:shadcn-ui",
    kind: "skill",
    name: "Shadcn UI",
    description:
      "Build UI components with shadcn/ui. Pairs with the Stitch design loop to ship structured, accessible components quickly.",
    source: { path: "skills/shadcn-ui/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:shader-dev",
    kind: "skill",
    name: "Shader Dev",
    description:
      "GLSL shader techniques for ray marching, fluid simulation, particle systems, and procedural generation. Useful for hero visuals and motion stills.",
    source: { path: "skills/shader-dev/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:slack-gif-creator",
    kind: "skill",
    name: "Slack GIF Creator",
    description:
      "Create animated GIFs optimized for Slack with validators for size constraints and composable animation primitives.",
    source: { path: "skills/slack-gif-creator/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.image,
  },
  {
    id: "skill:slides",
    kind: "skill",
    name: "Slides",
    description:
      "Create and edit .pptx presentation decks with PptxGenJS. Useful for sales decks, kickoff briefs, and design-system showcases.",
    source: { path: "skills/slides/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.deck,
  },
  {
    id: "skill:social-reddit-card",
    kind: "skill",
    name: "Social Reddit Card",
    description:
      "Realistic Reddit post card with vote rail and comment count, suited to video overlays or story sharing.",
    source: { path: "skills/social-reddit-card/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:social-spotify-card",
    kind: "skill",
    name: "Social Spotify Card",
    description:
      "Spotify Now Playing-style card with album art, progress bar, and playback controls, suited to video overlays or personal homepages.",
    source: { path: "skills/social-spotify-card/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:social-x-post-card",
    kind: "skill",
    name: "Social X Post Card",
    description:
      "Realistic X post card with engagement metrics (likes, reposts, views), suited to video overlays or shareable image cards.",
    source: { path: "skills/social-x-post-card/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:stitch-loop",
    kind: "skill",
    name: "Stitch Loop",
    description:
      "Iterative design-to-code feedback loop. Critique adjust ship cycle for tightening visual fidelity between brief and built UI.",
    source: { path: "skills/stitch-loop/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:swiftui-design",
    kind: "skill",
    name: "Swiftui Design",
    description:
      "SwiftUI skill - anti AI-slop rules, design direction advisor, brand asset protocol, and five-dimension review. Works with Claude Code, Cursor, Codex, and OpenCode.",
    source: { path: "skills/swiftui-design/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:swiss-creative-mode-template",
    kind: "skill",
    name: "Swiss Creative Mode Template",
    description:
      "Swiss-inspired creative-mode presentation template — bold editorial typography, high-contrast geometric cards, interactive slide navigation, theme switching, hotspot overlays.",
    source: { path: "skills/swiss-creative-mode-template/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.template,
  },
  {
    id: "skill:swiss-user-research-video-template",
    kind: "skill",
    name: "Swiss User Research Video Template",
    description:
      "Swiss-style user-research narrative template in warm-paper editorial aesthetics — minimalist typography, donut breakdowns, keyboard/click navigation, single-file HTML.",
    source: { path: "skills/swiss-user-research-video-template/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.template,
  },
  {
    id: "skill:taste-skill",
    kind: "skill",
    name: "Taste Skill",
    description:
      "High-agency frontend skill that gives AI good taste with tunable design variance, motion intensity, and visual density to stop generic UI slop.",
    source: { path: "skills/taste-skill/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:theme-factory",
    kind: "skill",
    name: "Theme Factory",
    description:
      "Apply professional font and color themes to artifacts including slides, docs, reports, and HTML landing pages. Ships 10 pre-set themes.",
    source: { path: "skills/theme-factory/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:threejs",
    kind: "skill",
    name: "Threejs",
    description:
      "Three.js skills for creating 3D elements and interactive experiences in the browser - scenes, materials, controls, and post-processing.",
    source: { path: "skills/threejs/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.prototype,
  },
  {
    id: "skill:ui-skills",
    kind: "skill",
    name: "UI Skills",
    description:
      "Opinionated, evolving constraints to guide agents when building interfaces. Useful for keeping output coherent across many small UI pieces.",
    source: { path: "skills/ui-skills/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:ui-ux-pro-max",
    kind: "skill",
    name: "UI UX Pro Max",
    description:
      "Catalog-only UI/UX Pro Max entry. The full upstream templates, data, and search workflow are not bundled in this registry.",
    source: { path: "skills/ui-ux-pro-max/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:vfx-text-cursor",
    kind: "skill",
    name: "VFX Text Cursor",
    description:
      "Cursor light trail, chromatic rays, and directional flares for word-by-word quote reveals in video intros.",
    source: { path: "skills/vfx-text-cursor/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.video,
  },
  {
    id: "skill:video-hyperframes",
    kind: "skill",
    name: "Video Hyperframes",
    description:
      "Hyperframes / Remotion-compatible continuous frame animation with autoplay support.",
    source: { path: "skills/video-hyperframes/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.video,
  },
  {
    id: "skill:web-design-guidelines",
    kind: "skill",
    name: "Web Design Guidelines",
    description:
      "Web design guidelines and standards by the Vercel engineering team. Covers layout, typography, color, motion, and accessibility for product UI.",
    source: { path: "skills/web-design-guidelines/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "skill:weread-year-in-review-video-template",
    kind: "skill",
    name: "Weread Year In Review Video Template",
    description:
      "WeRead-inspired HyperFrames video template for vertical annual reading reports — warm paper texture, editorial Chinese typography, book-page metaphors, deterministic motion.",
    source: { path: "skills/weread-year-in-review-video-template/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS.template,
  },
  {
    id: "skill:wpds",
    kind: "skill",
    name: "WPDS",
    description:
      "WordPress Design System. Apply WordPress's official design tokens, typography, and component patterns to themes and sites.",
    source: { path: "skills/wpds/SKILL.md" },
    targets: OPEN_DESIGN_SKILL_TARGETS["design-system"],
  },
  {
    id: "template:dashboard",
    kind: "template",
    name: "Dashboard",
    description:
      "Admin or analytics dashboard in a single HTML file with fixed sidebar, top bar, KPI cards, and one or two charts.",
    source: { path: "design-templates/dashboard" },
    targets: ["dashboard-design"],
  },
  {
    id: "template:finance-report",
    kind: "template",
    name: "Finance Report",
    description:
      "Quarterly or monthly financial report with masthead KPIs, revenue and burn charts, P&L summary, highlights, and outlook.",
    source: { path: "design-templates/finance-report" },
    targets: ["report"],
  },
  {
    id: "template:docs-page",
    kind: "template",
    name: "Docs Page",
    description:
      "Documentation page with inline-start navigation, scrollable article body, and inline-end table of contents.",
    source: { path: "design-templates/docs-page" },
    targets: ["docs-design"],
  },
  {
    id: "template:mobile-app",
    kind: "template",
    name: "Mobile App Design",
    description:
      "Mobile app screen rendered inside a pixel-accurate iPhone 15 Pro frame using reusable screen archetypes.",
    source: { path: "design-templates/mobile-app" },
    targets: ["mobile-app-design"],
  },

  {
    id: "template:html-ppt-zhangzara-retro-zine",
    kind: "template",
    name: "Zhangzara Retro Zine",
    description:
      "Retro editorial zine presentation template with expressive composition, tactile paper energy, and bold magazine-like rhythm.",
    source: { path: "design-templates/html-ppt-zhangzara-retro-zine" },
    targets: ["poster"],
  },
  {
    id: "template:weekly-update",
    kind: "template",
    name: "Weekly Update",
    description:
      "Single-file horizontal-swipe weekly team update deck for shipped work, in-flight work, blockers, metrics, and asks.",
    source: { path: "design-templates/weekly-update" },
    targets: ["report"],
  },
  {
    id: "template:web-prototype-taste-editorial",
    kind: "template",
    name: "Taste Editorial Web Prototype",
    description:
      "Editorial-minimalist web prototype with warm monochrome canvas, serif display type, hairline borders, pastel chips, and ambient micro-motion.",
    source: { path: "design-templates/web-prototype-taste-editorial" },
    targets: ["website"],
  },
  {
    id: "template:audio-jingle",
    kind: "template",
    name: "Audio Jingle",
    description:
      "Audio generation skill — jingles, beds, voiceover, and sound effects. Routes music requests to Suno V5 / Udio / Lyria, speech to MiniMax TTS / FishAudio / ElevenLabs V3, and SFX to ElevenLabs SFX or AudioCraft. Output is one MP3/WAV file…",
    source: { path: "design-templates/audio-jingle" },
    targets: ["intro-video"],
  },
  {
    id: "template:blog-post",
    kind: "template",
    name: "Blog Post",
    description:
      "A long-form article / blog post — masthead, hero image placeholder, article body with figures and pull quotes, author byline, related posts.",
    source: { path: "design-templates/blog-post" },
    targets: ["website"],
  },
  {
    id: "template:clinical-case-report",
    kind: "template",
    name: "Clinical Case Report",
    description:
      "Structured medical case presentation for clinical rounds, conferences, and documentation. Generates SOAP-format or narrative case reports with physiologically accurate vitals, labs, and evidence-based plans.",
    source: { path: "design-templates/clinical-case-report" },
    targets: ["report"],
  },
  {
    id: "template:critique",
    kind: "template",
    name: "Critique",
    description:
      "Run a 5-dimension expert design review on any HTML artifact in the project — Philosophy / Visual hierarchy / Detail / Functionality / Innovation, each scored 0–10. Outputs a single self-contained HTML report with a radar chart, evidence…",
    source: { path: "design-templates/critique" },
    targets: [
      "website",
      "dashboard-design",
      "report",
      "docs-design",
      "poster",
      "mobile-app-design",
    ],
  },
  {
    id: "template:dating-web",
    kind: "template",
    name: "Dating Web",
    description:
      "A consumer-feeling dating / matchmaking dashboard — left rail navigation, ticker bar of community signals, headline KPIs, a 30-day mutual-matches bar chart, and a match-rate trend block. Editorial typography, restrained accent.",
    source: { path: "design-templates/dating-web" },
    targets: ["website"],
  },
  {
    id: "template:dcf-valuation",
    kind: "template",
    name: "Dcf Valuation",
    description:
      "Discounted cash flow valuation and intrinsic value analysis for public companies.",
    source: { path: "design-templates/dcf-valuation" },
    targets: ["report"],
  },
  {
    id: "template:digital-eguide",
    kind: "template",
    name: "Digital Eguide",
    description:
      'A two-spread digital e-guide preview — page 1 is a cover (display title, author, "What\'s inside" stats, table of contents teaser); page 2 is a spread (lesson body with pull-quote and a step list). Lifestyle / creator brand tone.',
    source: { path: "design-templates/digital-eguide" },
    targets: ["website", "docs-design"],
  },
  {
    id: "template:email-marketing",
    kind: "template",
    name: "Email Marketing",
    description:
      "A brand product-launch email — masthead with wordmark, hero image block, headline lockup with skewed-italic accent, body copy, primary CTA, and a specifications grid. Pure HTML email layout (centered single column, table fallback).",
    source: { path: "design-templates/email-marketing" },
    targets: ["website"],
  },
  {
    id: "template:eng-runbook",
    kind: "template",
    name: "Eng Runbook",
    description:
      "An engineering runbook — service overview, alerts table, dashboards links, common procedures with copy-pasteable commands, on-call rotation, and an incident-response checklist.",
    source: { path: "design-templates/eng-runbook" },
    targets: ["docs-design"],
  },
  {
    id: "template:flowai-live-dashboard-template",
    kind: "template",
    name: "Flowai Live Dashboard Template",
    description:
      "FlowAI team-management dashboard — three tabs (Members, Details, Activity Log), KPI row, role chart, presence sparklines, contributor panel, light/dark, CSV export, single HTML.",
    source: { path: "design-templates/flowai-live-dashboard-template" },
    targets: ["dashboard-design"],
  },
  {
    id: "template:gamified-app",
    kind: "template",
    name: "Gamified App",
    description:
      "A multi-frame gamified mobile-app prototype — three phone frames on a dark showcase stage. Frame 1: cover / poster, Frame 2: today's quests with XP ribbons and a level bar, Frame 3: quest detail. Vivid quest tiles, level ribbon, bottom t…",
    source: { path: "design-templates/gamified-app" },
    targets: ["website", "mobile-app-design"],
  },
  {
    id: "template:github-dashboard",
    kind: "template",
    name: "Github Dashboard",
    description:
      "GitHub repository analytics dashboard — stars, forks, contributors, issues, pull requests, recent activity, and top contributors.",
    source: { path: "design-templates/github-dashboard" },
    targets: ["dashboard-design"],
  },

  {
    id: "template:hr-onboarding",
    kind: "template",
    name: "Hr Onboarding",
    description:
      'A new-hire onboarding plan as a single page — first week schedule, buddy + manager intro, learning track, equipment checklist, and "you\'re set when…" outcomes.',
    source: { path: "design-templates/hr-onboarding" },
    targets: ["docs-design"],
  },

  {
    id: "template:html-ppt-weekly-report",
    kind: "template",
    name: "HTML PPT Weekly Report",
    description:
      "Team weekly / status-update deck — corporate clarity, 8-cell KPI grid, shipped list, 8-week bar chart, next-week table. Use for 周报, business reviews, team status updates, and exec dashboards.",
    source: { path: "design-templates/html-ppt-weekly-report" },
    targets: ["report"],
  },
  {
    id: "template:html-ppt-xhs-pastel-card",
    kind: "template",
    name: "HTML PPT Xhs Pastel Card",
    description:
      "柔和马卡龙慢生活 deck — 奶油底 + 柔光 blob、Playfair 斜体 + sans 正文、28px 圆角马卡龙卡片、SVG donut 图、chip+page 顶栏。适合生活方式 / 个人成长 / 慢生活内容。",
    source: { path: "design-templates/html-ppt-xhs-pastel-card" },
    targets: ["poster"],
  },
  {
    id: "template:html-ppt-xhs-post",
    kind: "template",
    name: "HTML PPT Xhs Post",
    description:
      "小红书 / Instagram 风 9 页 3:4 竖版图文（810×1080）— 暖色 pastel、虚线 sticker 卡片、底部页码点点。",
    source: { path: "design-templates/html-ppt-xhs-post" },
    targets: ["poster"],
  },
  {
    id: "template:html-ppt-xhs-white-editorial",
    kind: "template",
    name: "HTML PPT Xhs White Editorial",
    description:
      "白底杂志风 deck — 纯白 + 顶部 10 色彩虹 bar、80-110px display 标题、紫→蓝→绿→橙→粉渐变文字、马卡龙软卡片组、黑底白字 .focus pill。小红书图文 + 横版 PPT 双用。",
    source: { path: "design-templates/html-ppt-xhs-white-editorial" },
    targets: ["poster"],
  },

  {
    id: "template:html-ppt-zhangzara-biennale-yellow",
    kind: "template",
    name: "HTML PPT Zhangzara Biennale Yellow",
    description:
      "Biennale Yellow — solar yellow on warm parchment with deep indigo serif and sun-glow gradients. For art-biennale posters, museum programmes, curatorial pitches, literary publications.",
    source: { path: "design-templates/html-ppt-zhangzara-biennale-yellow" },
    targets: ["poster"],
  },

  {
    id: "template:html-ppt-zhangzara-bold-poster",
    kind: "template",
    name: "HTML PPT Zhangzara Bold Poster",
    description:
      "Bold Poster — editorial poster aesthetic with massive Shrikhand display and a single fire-engine red accent. For magazine-cover brand manifestos and editorial / cultural pitches.",
    source: { path: "design-templates/html-ppt-zhangzara-bold-poster" },
    targets: ["poster"],
  },

  {
    id: "template:hyperframes",
    kind: "template",
    name: "Hyperframes",
    description:
      "HTML video composition skill — captions, voiceover, audio-reactive animation, scene transitions, and timing in HyperFrames HTML. For CLI commands see hyperframes-cli.",
    source: { path: "design-templates/hyperframes" },
    targets: ["intro-video"],
  },
  {
    id: "template:ib-pitch-book",
    kind: "template",
    name: "Ib Pitch Book",
    description:
      "Investment-banking pitch book — trading comps, precedent transactions, valuation football field, DCF sensitivity, strategic-options matrix. For Board / sell-side discussion materials.",
    source: { path: "design-templates/ib-pitch-book" },
    targets: ["report"],
  },
  {
    id: "template:image-poster",
    kind: "template",
    name: "Image Poster",
    description:
      "Single-image generation skill for posters, key art, and editorial illustrations. Defaults to gpt-image-2 but is provider-agnostic — the same workflow drives Flux, Imagen, or Midjourney via the active upstream tooling. Output is one or mo…",
    source: { path: "design-templates/image-poster" },
    targets: ["poster"],
  },
  {
    id: "template:invoice",
    kind: "template",
    name: "Invoice",
    description:
      "A printable invoice page — sender + recipient block, line items table, tax breakdown, totals, and payment instructions.",
    source: { path: "design-templates/invoice" },
    targets: ["report"],
  },

  {
    id: "template:kami-landing",
    kind: "template",
    name: "Kami Landing",
    description:
      "Produce a print-grade single-page kami (紙 / 纸) document — warm parchment canvas, ink-blue accent, serif at one weight, no italic, no cool grays. The output reads like a professional white paper or studio one-pager, not an app UI. Multili…",
    source: { path: "design-templates/kami-landing" },
    targets: ["website"],
  },
  {
    id: "template:kanban-board",
    kind: "template",
    name: "Kanban Board",
    description:
      "Kanban / task board with columns (To do / In progress / In review / Done), draggable-looking cards, assignee avatars, swimlanes, and a top filter bar.",
    source: { path: "design-templates/kanban-board" },
    targets: ["dashboard-design"],
  },
  {
    id: "template:last30days",
    kind: "template",
    name: "Last30days",
    description:
      "Recent community and social trend research over the last 30 days.",
    source: { path: "design-templates/last30days" },
    targets: ["dashboard-design", "report"],
  },
  {
    id: "template:live-artifact",
    kind: "template",
    name: "Live Artifact",
    description:
      "Create refreshable, auditable artifacts backed by connector or local data. Trigger when the user asks for live dashboards, refreshable reports, synced views, or reusable data-backed artifacts.",
    source: { path: "design-templates/live-artifact" },
    targets: ["dashboard-design", "report", "website"],
  },
  {
    id: "template:live-dashboard",
    kind: "template",
    name: "Live Dashboard",
    description:
      "Notion-style team dashboard as a Live Artifact — KPIs, 7-day sparkline, activity feed, and a linked-database task table wired to Notion via Composio. Refreshable, with mock fallback.",
    source: { path: "design-templates/live-dashboard" },
    targets: ["dashboard-design"],
  },
  {
    id: "template:magazine-poster",
    kind: "template",
    name: "Magazine Poster",
    description:
      "An editorial-style poster — newsprint paper, dateline, oversized serif headline with a struck-through word and italic accent, a 2-column body block, and 6 numbered sections with annotated pull-quote captions. Reads like a Sunday-paper fu…",
    source: { path: "design-templates/magazine-poster" },
    targets: ["poster"],
  },
  {
    id: "template:meeting-notes",
    kind: "template",
    name: "Meeting Notes",
    description:
      'Meeting notes page — title bar with attendees, agenda checklist, decisions block, action items table with owners + dates, and a "next meeting" footer.',
    source: { path: "design-templates/meeting-notes" },
    targets: ["docs-design"],
  },
  {
    id: "template:mobile-onboarding",
    kind: "template",
    name: "Mobile Onboarding",
    description:
      "A multi-screen mobile onboarding flow rendered as three phone frames side by side — splash, value-prop, sign-in. Status bar, swipe dots, primary CTA.",
    source: { path: "design-templates/mobile-onboarding" },
    targets: ["mobile-app-design"],
  },
  {
    id: "template:motion-frames",
    kind: "template",
    name: "Motion Frames",
    description:
      "A single-frame motion-design composition with looping CSS animations — rotating type ring, animated globe, ticking timer, parallax labels. Renders as a hero video poster you can hand straight to HyperFrames or any keyframe-based exporter.",
    source: { path: "design-templates/motion-frames" },
    targets: ["intro-video"],
  },
  {
    id: "template:open-design-landing",
    kind: "template",
    name: "Editorial Landing",
    description:
      "Single-page editorial landing site in the Atelier Zero visual language (Monocle / Apartamento / Études collage). Composes from a typed inputs.json with optional gpt-image-2 assets.",
    source: { path: "design-templates/open-design-landing" },
    targets: ["website"],
  },

  {
    id: "template:orbit-general",
    kind: "template",
    name: "Orbit General",
    description:
      "Open Orbit daily digest — pulls 24h activity from every connected connector (GitHub, Linear, Notion, Slack, …) into a bento-grid dashboard. Invoked by the Orbit scheduler.",
    source: { path: "design-templates/orbit-general" },
    targets: ["dashboard-design"],
  },
  {
    id: "template:orbit-github",
    kind: "template",
    name: "Orbit Github",
    description:
      "Open Orbit GitHub digest — 24h of PRs, reviews, issues, CI, and merges rendered in GitHub's native Notifications + PR-diff visual language. Invoked by the Orbit scheduler.",
    source: { path: "design-templates/orbit-github" },
    targets: ["dashboard-design"],
  },
  {
    id: "template:orbit-gmail",
    kind: "template",
    name: "Orbit Gmail",
    description:
      "Open Orbit Gmail digest — 24h of inbox activity (replies, mentions, cc, bulk) rendered as the Orbit Daily Digest email inside Gmail's reading view. Invoked by the Orbit scheduler.",
    source: { path: "design-templates/orbit-gmail" },
    targets: ["dashboard-design"],
  },
  {
    id: "template:orbit-linear",
    kind: "template",
    name: "Orbit Linear",
    description:
      "Open Orbit Linear digest — 24h of issue movement, status changes, assignments, and cycle progress in Linear's native Inbox + cycle visual language. Invoked by the Orbit scheduler.",
    source: { path: "design-templates/orbit-linear" },
    targets: ["dashboard-design"],
  },
  {
    id: "template:orbit-notion",
    kind: "template",
    name: "Orbit Notion",
    description:
      "Open Orbit Notion digest — 24h of doc edits, comments, mentions, and database row changes rendered as a native Notion page. Invoked by the Orbit scheduler.",
    source: { path: "design-templates/orbit-notion" },
    targets: ["dashboard-design"],
  },
  {
    id: "template:pm-spec",
    kind: "template",
    name: "Pm Spec",
    description:
      "Product spec / PRD as a single page — problem, success metrics, scope, user stories, design notes, rollout plan, open questions.",
    source: { path: "design-templates/pm-spec" },
    targets: ["docs-design"],
  },
  {
    id: "template:pricing-page",
    kind: "template",
    name: "Pricing Page",
    description:
      "A standalone pricing page — header, plan tiers, feature comparison table, and an FAQ.",
    source: { path: "design-templates/pricing-page" },
    targets: ["website"],
  },

  {
    id: "template:saas-landing",
    kind: "template",
    name: "Saas Landing",
    description:
      "Single-page SaaS landing with hero, features, social proof, pricing, and CTA. Respects the active DESIGN.md color/typography/layout tokens.",
    source: { path: "design-templates/saas-landing" },
    targets: ["website"],
  },

  {
    id: "template:social-carousel",
    kind: "template",
    name: "Social Carousel",
    description:
      'A three-card social-media carousel laid out as 1080×1080 squares — three cinematic, on-brand panels with display headlines that connect across the series ("onwards." → "to the next one." → "looking ahead."). Each card has a brand mark, a…',
    source: { path: "design-templates/social-carousel" },
    targets: ["poster"],
  },
  {
    id: "template:social-media-dashboard",
    kind: "template",
    name: "Social Media Dashboard",
    description:
      'Creator-facing social media analytics dashboard in a single HTML file. A platform switcher (X / LinkedIn / YouTube / Instagram), a row of KPI cards (followers, engagement rate, likes, reposts), a follower-growth chart, a "top post this w…',
    source: { path: "design-templates/social-media-dashboard" },
    targets: ["dashboard-design"],
  },
  {
    id: "template:social-media-matrix-tracker-template",
    kind: "template",
    name: "Social Media Matrix Tracker Template",
    description: "社媒矩阵数据追踪面板模板（Social Media Matrix Tracker）。",
    source: { path: "design-templates/social-media-matrix-tracker-template" },
    targets: ["dashboard-design"],
  },
  {
    id: "template:sprite-animation",
    kind: "template",
    name: "Sprite Animation",
    description:
      "A pixel / sprite-style animated explainer slide — full-bleed cream stage, bold display year, animated pixel-art mascot (e.g. Hanafuda card, mushroom, or 8-bit console), kinetic Japanese display type, ticking timeline ribbon. Reads like a…",
    source: { path: "design-templates/sprite-animation" },
    targets: ["intro-video"],
  },
  {
    id: "template:team-okrs",
    kind: "template",
    name: "Team Okrs",
    description:
      'OKR tracker page — quarter banner, three objectives with their key results as progress bars, owner avatars, status pills, and a "this quarter at a glance" sidebar.',
    source: { path: "design-templates/team-okrs" },
    targets: ["docs-design", "dashboard-design"],
  },
  {
    id: "template:trading-analysis-dashboard-template",
    kind: "template",
    name: "Trading Analysis Dashboard Template",
    description:
      "Professional trading analysis dashboard template (single-file HTML) with light/dark theme switch, dense market panels, chart interactions, demo/live playback, and command palette behavior.",
    source: { path: "design-templates/trading-analysis-dashboard-template" },
    targets: ["dashboard-design"],
  },
  {
    id: "template:tweaks",
    kind: "template",
    name: "Tweaks",
    description:
      "Wrap any HTML artifact with a side panel of live, parameterized controls — accent color, type scale, density, motion, theme — that rewrite CSS custom properties in real time and persist to localStorage. Lets the user explore variants of…",
    source: { path: "design-templates/tweaks" },
    targets: [
      "website",
      "dashboard-design",
      "report",
      "docs-design",
      "poster",
      "mobile-app-design",
    ],
  },
  {
    id: "template:video-shortform",
    kind: "template",
    name: "Video Shortform",
    description:
      "Short-form video generation skill — 3-10 second clips for product reveals, motion teasers, ambient loops. Defaults to Seedance 2 but works the same with Kling 3 / 4, Veo 3 or Sora 2. Output is one MP4 saved to the project folder. When th…",
    source: { path: "design-templates/video-shortform" },
    targets: ["intro-video"],
  },
  {
    id: "template:waitlist-page",
    kind: "template",
    name: "Waitlist Page",
    description:
      "Minimal pre-launch landing with email capture, brand logo, and optional decorative layer. Reads DESIGN.md for colors, typography, and layout rules.",
    source: { path: "design-templates/waitlist-page" },
    targets: ["website"],
  },
  {
    id: "template:web-prototype",
    kind: "template",
    name: "Web Prototype",
    description:
      "General-purpose desktop web prototype. Single self-contained HTML file built by copying the seed `assets/template.html` and pasting section layouts from `references/layouts.md`. Default for any landing / marketing / docs / SaaS page when…",
    source: { path: "design-templates/web-prototype" },
    targets: ["website"],
  },
  {
    id: "template:web-prototype-taste-brutalist",
    kind: "template",
    name: "Web Prototype Taste Brutalist",
    description:
      "Swiss industrial-print web prototype. Newsprint canvas, monolithic black grotesque, viewport-bleeding numerals, hairline grid dividers, hazard-red accent, ASCII syntax decoration. Distilled from Leonxlnx/taste-skill `brutalist-skill` (Sw…",
    source: { path: "design-templates/web-prototype-taste-brutalist" },
    targets: ["website"],
  },
  {
    id: "template:web-prototype-taste-soft",
    kind: "template",
    name: "Web Prototype Taste Soft",
    description:
      "Apple-tier soft web prototype. Silver/cream canvas, double-bezel cards, button-in-button CTAs, generous squircle radii, spring motion, ambient mesh. Distilled from Leonxlnx/taste-skill `soft-skill` + sections 4–8 of `taste-skill`.",
    source: { path: "design-templates/web-prototype-taste-soft" },
    targets: ["website"],
  },
  {
    id: "template:wireframe-sketch",
    kind: "template",
    name: "Wireframe Sketch",
    description:
      "A hand-drawn wireframe exploration — graph-paper background, marker / pencil tone, multiple tab labels for variants, sticky-note annotations, scribbled chart placeholders, hatched fills. Reads like a designer's whiteboard before any pixe…",
    source: { path: "design-templates/wireframe-sketch" },
    targets: ["website", "mobile-app-design", "dashboard-design"],
  },
  {
    id: "template:x-research",
    kind: "template",
    name: "X Research",
    description:
      "X/Twitter public sentiment research for recent market, company, product, or community discourse.",
    source: { path: "design-templates/x-research" },
    targets: ["report"],
  },
  {
    id: "design-system:dashboard",
    kind: "design-system",
    name: "Dashboard",
    description:
      "Dark cloud-platform aesthetic with modular grids, glass-like panels, and strong data hierarchy for productivity dashboards.",
    source: { path: "design-systems/dashboard" },
  },
  {
    id: "design-system:trading-terminal",
    kind: "design-system",
    name: "Trading Terminal",
    description:
      "Bloomberg-style financial trading terminal: dark-only, data-dense, with cyan and coral buy/sell signals readable at a glance.",
    source: { path: "design-systems/trading-terminal" },
  },
  {
    id: "design-system:warm-editorial",
    kind: "design-system",
    name: "Warm Editorial",
    description:
      "Serif-led magazine aesthetic with terracotta accents on warm off-white paper for readable narrative pages, zines, and reports.",
    source: { path: "design-systems/warm-editorial" },
  },
  {
    id: "design-system:editorial",
    kind: "design-system",
    name: "Editorial",
    description:
      "Magazine-inspired editorial layout with refined serif typography, structured grids, and elegant reading experiences.",
    source: { path: "design-systems/editorial" },
  },
  {
    id: "design-system:mono",
    kind: "design-system",
    name: "Mono",
    description:
      "Monospace-driven, matrix-inspired design with high-contrast elements, compact density, and a hacker-chic aesthetic.",
    source: { path: "design-systems/mono" },
  },
  {
    id: "design-system:apple",
    kind: "design-system",
    name: "Apple",
    description:
      "Consumer electronics design system with premium white space, SF Pro-style typography, and cinematic imagery.",
    source: { path: "design-systems/apple" },
  },
  {
    id: "design-system:agentic",
    kind: "design-system",
    name: "Agentic",
    description:
      "Conversational AI-first interface with minimal controls, clear outcomes, and delegated task flows for agentic workflows.",
    source: { path: "design-systems/agentic" },
  },
  {
    id: "design-system:airbnb",
    kind: "design-system",
    name: "Airbnb",
    description:
      "Travel marketplace. Warm coral accent, photography-driven, rounded UI.",
    source: { path: "design-systems/airbnb" },
  },
  {
    id: "design-system:airtable",
    kind: "design-system",
    name: "Airtable",
    description:
      "Spreadsheet-database hybrid. Colorful, friendly, structured data aesthetic.",
    source: { path: "design-systems/airtable" },
  },
  {
    id: "design-system:ant",
    kind: "design-system",
    name: "Ant",
    description:
      "Structured, enterprise-focused design system emphasizing clarity, consistency, and efficiency for data-dense web applications.",
    source: { path: "design-systems/ant" },
  },
  {
    id: "design-system:application",
    kind: "design-system",
    name: "Application",
    description:
      "App dashboard with purple-themed aesthetic, top-bar navigation, card-based layouts, and developer-first workflows.",
    source: { path: "design-systems/application" },
  },
  {
    id: "design-system:arc",
    kind: "design-system",
    name: "Arc",
    description:
      '"The browser that browses for you." Translucent surfaces, gradient warmth, sidebar-first layout.',
    source: { path: "design-systems/arc" },
  },
  {
    id: "design-system:artistic",
    kind: "design-system",
    name: "Artistic",
    description:
      "High-contrast, expressive style with creative typography and bold color choices for visually striking interfaces.",
    source: { path: "design-systems/artistic" },
  },
  {
    id: "design-system:atelier-zero",
    kind: "design-system",
    name: "Atelier Zero",
    description:
      "A magazine-grade, collage-driven visual system: warm paper canvas, surreal.",
    source: { path: "design-systems/atelier-zero" },
  },
  {
    id: "design-system:bento",
    kind: "design-system",
    name: "Bento",
    description:
      "Modular grid layout with card-like blocks, clear hierarchy, soft spacing, and subtle visual contrast for organized, scannable interfaces.",
    source: { path: "design-systems/bento" },
  },
  {
    id: "design-system:binance",
    kind: "design-system",
    name: "Binance",
    description:
      "Crypto exchange. Bold yellow accent on monochrome, trading-floor urgency.",
    source: { path: "design-systems/binance" },
  },
  {
    id: "design-system:bmw",
    kind: "design-system",
    name: "Bmw",
    description:
      "Luxury automotive. Dark premium surfaces, precise German engineering aesthetic.",
    source: { path: "design-systems/bmw" },
  },
  {
    id: "design-system:bmw-m",
    kind: "design-system",
    name: "Bmw M",
    description:
      "Motorsport performance sub-brand. Near-black cockpit surfaces, BMW M tricolor accents, sharp engineering geometry.",
    source: { path: "design-systems/bmw-m" },
  },
  {
    id: "design-system:bold",
    kind: "design-system",
    name: "Bold",
    description:
      "Strong visual presence with heavyweight typography, high-contrast colors, and commanding layouts.",
    source: { path: "design-systems/bold" },
  },
  {
    id: "design-system:brutalism",
    kind: "design-system",
    name: "Brutalism",
    description:
      "Raw, anti-design aesthetic inspired by concrete architecture with unadorned elements, jarring layouts, and functional minimalism.",
    source: { path: "design-systems/brutalism" },
  },
  {
    id: "design-system:bugatti",
    kind: "design-system",
    name: "Bugatti",
    description:
      "Hypercar brand. Cinema-black canvas, monochrome austerity, monumental display type.",
    source: { path: "design-systems/bugatti" },
  },
  {
    id: "design-system:cafe",
    kind: "design-system",
    name: "Cafe",
    description:
      "Cozy cafe-inspired interface with warm tones, soft typography, and clean layouts for a relaxed browsing experience.",
    source: { path: "design-systems/cafe" },
  },
  {
    id: "design-system:cal",
    kind: "design-system",
    name: "Cal",
    description:
      "Open-source scheduling. Clean neutral UI, developer-oriented simplicity.",
    source: { path: "design-systems/cal" },
  },
  {
    id: "design-system:canva",
    kind: "design-system",
    name: "Canva",
    description:
      "Visual creation platform. Vivid purple-blue gradient, generous spacing, friendly geometry.",
    source: { path: "design-systems/canva" },
  },
  {
    id: "design-system:cisco",
    kind: "design-system",
    name: "Cisco",
    description:
      "Enterprise infrastructure brand. Dark trust surfaces, Cisco Blue signal, technical clarity.",
    source: { path: "design-systems/cisco" },
  },
  {
    id: "design-system:claude",
    kind: "design-system",
    name: "Claude",
    description:
      "Anthropic's AI assistant. Warm terracotta accent, clean editorial layout.",
    source: { path: "design-systems/claude" },
  },
  {
    id: "design-system:clay",
    kind: "design-system",
    name: "Clay",
    description:
      "Creative agency. Organic shapes, soft gradients, art-directed layout.",
    source: { path: "design-systems/clay" },
  },
  {
    id: "design-system:claymorphism",
    kind: "design-system",
    name: "Claymorphism",
    description:
      "Soft, rounded 3D-like shapes mimicking malleable clay with playful, puffy elements and colorful surfaces.",
    source: { path: "design-systems/claymorphism" },
  },
  {
    id: "design-system:clean",
    kind: "design-system",
    name: "Clean",
    description:
      "Simplicity-focused design with ample whitespace, legible typography, and a limited color palette to reduce visual clutter.",
    source: { path: "design-systems/clean" },
  },
  {
    id: "design-system:clickhouse",
    kind: "design-system",
    name: "Clickhouse",
    description:
      "Fast analytics database. Yellow-accented, technical documentation style.",
    source: { path: "design-systems/clickhouse" },
  },
  {
    id: "design-system:cohere",
    kind: "design-system",
    name: "Cohere",
    description:
      "Enterprise AI platform. Vibrant gradients, data-rich dashboard aesthetic.",
    source: { path: "design-systems/cohere" },
  },
  {
    id: "design-system:coinbase",
    kind: "design-system",
    name: "Coinbase",
    description:
      "Crypto exchange. Clean blue identity, trust-focused, institutional feel.",
    source: { path: "design-systems/coinbase" },
  },
  {
    id: "design-system:colorful",
    kind: "design-system",
    name: "Colorful",
    description:
      "Vibrant, high-contrast palettes and gradients for engaging, memorable, and modern user experiences.",
    source: { path: "design-systems/colorful" },
  },
  {
    id: "design-system:composio",
    kind: "design-system",
    name: "Composio",
    description:
      "Tool integration platform. Modern dark with colorful integration icons.",
    source: { path: "design-systems/composio" },
  },
  {
    id: "design-system:contemporary",
    kind: "design-system",
    name: "Contemporary",
    description:
      "Current-era minimalist design with bento grids, dark mode support, and high-performance accessible layouts.",
    source: { path: "design-systems/contemporary" },
  },
  {
    id: "design-system:corporate",
    kind: "design-system",
    name: "Corporate",
    description:
      "Professional, brand-aligned design with structured grids, minimalist layouts, and consistent enterprise patterns.",
    source: { path: "design-systems/corporate" },
  },
  {
    id: "design-system:cosmic",
    kind: "design-system",
    name: "Cosmic",
    description:
      "Futuristic sci-fi aesthetic with dark themes, vibrant neon accents, and immersive spatial elements.",
    source: { path: "design-systems/cosmic" },
  },
  {
    id: "design-system:creative",
    kind: "design-system",
    name: "Creative",
    description:
      "Playful, character-driven design with expressive typography and bold graphics for landing pages and creative projects.",
    source: { path: "design-systems/creative" },
  },
  {
    id: "design-system:cursor",
    kind: "design-system",
    name: "Cursor",
    description:
      "AI-first code editor. Sleek dark interface, gradient accents.",
    source: { path: "design-systems/cursor" },
  },
  {
    id: "design-system:default",
    kind: "design-system",
    name: "Default",
    description: "A clean, product-oriented default.",
    source: { path: "design-systems/default" },
  },
  {
    id: "design-system:discord",
    kind: "design-system",
    name: "Discord",
    description:
      "Voice / chat platform. Deep blurple, dark-first surfaces, playful accent moments.",
    source: { path: "design-systems/discord" },
  },
  {
    id: "design-system:dithered",
    kind: "design-system",
    name: "Dithered",
    description:
      "Dot-pattern rendering technique that simulates shades with a limited palette for nostalgic, retro, high-contrast visuals.",
    source: { path: "design-systems/dithered" },
  },
  {
    id: "design-system:doodle",
    kind: "design-system",
    name: "Doodle",
    description:
      "Hand-drawn, sketch-like style with doodles, handwritten fonts, and imperfect lines for a playful, informal feel.",
    source: { path: "design-systems/doodle" },
  },
  {
    id: "design-system:dramatic",
    kind: "design-system",
    name: "Dramatic",
    description:
      "High-contrast, theatrical design with bold layouts, immersive visuals, and unconventional compositions that command attention.",
    source: { path: "design-systems/dramatic" },
  },
  {
    id: "design-system:duolingo",
    kind: "design-system",
    name: "Duolingo",
    description:
      "Language-learning platform. Bright owl green, chunky shadows, gamified joy.",
    source: { path: "design-systems/duolingo" },
  },
  {
    id: "design-system:elegant",
    kind: "design-system",
    name: "Elegant",
    description:
      "Graceful, refined aesthetic with delicate typography, minimal palettes, and polished layouts that exude sophistication.",
    source: { path: "design-systems/elegant" },
  },
  {
    id: "design-system:elevenlabs",
    kind: "design-system",
    name: "Elevenlabs",
    description:
      "AI voice platform. Dark cinematic UI, audio-waveform aesthetics.",
    source: { path: "design-systems/elevenlabs" },
  },
  {
    id: "design-system:energetic",
    kind: "design-system",
    name: "Energetic",
    description:
      "Dynamic, vibrant style with thick borders, geometric shapes, high-contrast colors, and expressive typography conveying motion and vitality.",
    source: { path: "design-systems/energetic" },
  },
  {
    id: "design-system:enterprise",
    kind: "design-system",
    name: "Enterprise",
    description:
      "Clean, high-contrast enterprise design for data-driven workflows with intuitive drag-and-drop patterns and structured layouts.",
    source: { path: "design-systems/enterprise" },
  },
  {
    id: "design-system:expo",
    kind: "design-system",
    name: "Expo",
    description:
      "React Native platform. Dark theme, tight letter-spacing, code-centric.",
    source: { path: "design-systems/expo" },
  },
  {
    id: "design-system:expressive",
    kind: "design-system",
    name: "Expressive",
    description:
      "Vibrant, personality-driven design with bold colors, playful graphics, and dynamic layouts that balance creativity with structure.",
    source: { path: "design-systems/expressive" },
  },
  {
    id: "design-system:fantasy",
    kind: "design-system",
    name: "Fantasy",
    description:
      "Game-inspired fantasy aesthetic with bold, premium visuals, rich color palettes, and immersive thematic elements.",
    source: { path: "design-systems/fantasy" },
  },
  {
    id: "design-system:ferrari",
    kind: "design-system",
    name: "Ferrari",
    description:
      "Luxury automotive. Chiaroscuro editorial, Ferrari Red accents, cinematic black.",
    source: { path: "design-systems/ferrari" },
  },
  {
    id: "design-system:figma",
    kind: "design-system",
    name: "Figma",
    description:
      "Collaborative design tool. Vibrant multi-color, playful yet professional.",
    source: { path: "design-systems/figma" },
  },
  {
    id: "design-system:flat",
    kind: "design-system",
    name: "Flat",
    description:
      "Two-dimensional minimalist style with vibrant colors, clean typography, and no 3D effects for fast, user-friendly interfaces.",
    source: { path: "design-systems/flat" },
  },
  {
    id: "design-system:framer",
    kind: "design-system",
    name: "Framer",
    description:
      "Website builder. Bold black and blue, motion-first, design-forward.",
    source: { path: "design-systems/framer" },
  },
  {
    id: "design-system:friendly",
    kind: "design-system",
    name: "Friendly",
    description:
      "Approachable, intuitive design with rounded elements, ample whitespace, and soft pastel color palettes.",
    source: { path: "design-systems/friendly" },
  },
  {
    id: "design-system:futuristic",
    kind: "design-system",
    name: "Futuristic",
    description:
      "Forward-looking design with tech-inspired typography, modern layouts, and a sleek, innovation-driven aesthetic.",
    source: { path: "design-systems/futuristic" },
  },
  {
    id: "design-system:github",
    kind: "design-system",
    name: "Github",
    description:
      "Code-forward platform. Functional density, blue-on-white precision, Primer foundations.",
    source: { path: "design-systems/github" },
  },
  {
    id: "design-system:glassmorphism",
    kind: "design-system",
    name: "Glassmorphism",
    description:
      "Frosted glass effect with translucent layers, subtle blur, and luminous borders for depth and modern elegance.",
    source: { path: "design-systems/glassmorphism" },
  },
  {
    id: "design-system:gradient",
    kind: "design-system",
    name: "Gradient",
    description:
      "Smooth color transitions and gradient-rich surfaces for modern, playful interfaces with visual depth.",
    source: { path: "design-systems/gradient" },
  },
  {
    id: "design-system:hashicorp",
    kind: "design-system",
    name: "Hashicorp",
    description:
      "Infrastructure automation. Enterprise-clean, black and white.",
    source: { path: "design-systems/hashicorp" },
  },
  {
    id: "design-system:hud",
    kind: "design-system",
    name: "Hud",
    description:
      "Fighter jet / helicopter head-up display. Phosphor green on near-black, all-caps data overlays, angular geometry. Zero ambiguity at speed and altitude.",
    source: { path: "design-systems/hud" },
  },
  {
    id: "design-system:huggingface",
    kind: "design-system",
    name: "Huggingface",
    description:
      "ML community hub. Sunny yellow accent, monospace identity, cheerful and dense.",
    source: { path: "design-systems/huggingface" },
  },
  {
    id: "design-system:ibm",
    kind: "design-system",
    name: "Ibm",
    description:
      "Enterprise technology. Carbon design system, structured blue palette.",
    source: { path: "design-systems/ibm" },
  },
  {
    id: "design-system:intercom",
    kind: "design-system",
    name: "Intercom",
    description:
      "Customer messaging. Friendly blue palette, conversational UI patterns.",
    source: { path: "design-systems/intercom" },
  },
  {
    id: "design-system:kami",
    kind: "design-system",
    name: "Kami",
    description:
      "Editorial paper system: warm parchment canvas, ink-blue accent, serif-led hierarchy. Built for resumes, one-pagers, white papers, portfolios, slide decks — anything that should feel like high-quality print rather than UI. Multilingual by…",
    source: { path: "design-systems/kami" },
  },
  {
    id: "design-system:kraken",
    kind: "design-system",
    name: "Kraken",
    description:
      "Crypto trading. Purple-accented dark UI, data-dense dashboards.",
    source: { path: "design-systems/kraken" },
  },
  {
    id: "design-system:lamborghini",
    kind: "design-system",
    name: "Lamborghini",
    description:
      "Supercar brand. True black surfaces, gold accents, dramatic uppercase typography.",
    source: { path: "design-systems/lamborghini" },
  },
  {
    id: "design-system:levels",
    kind: "design-system",
    name: "Levels",
    description:
      "Conversion-focused design that removes friction and guides users toward action through clarity, trust, and speed.",
    source: { path: "design-systems/levels" },
  },
  {
    id: "design-system:linear-app",
    kind: "design-system",
    name: "Linear App",
    description: "Project management. Ultra-minimal, precise, purple accent.",
    source: { path: "design-systems/linear-app" },
  },
  {
    id: "design-system:lingo",
    kind: "design-system",
    name: "Lingo",
    description:
      "Playful, minimal design with bright colors, rounded shapes, tactile 3D borders, and friendly illustrations for approachable interfaces.",
    source: { path: "design-systems/lingo" },
  },
  {
    id: "design-system:loom",
    kind: "design-system",
    name: "Loom",
    description:
      "Loom async video. Purple primary, friendly surfaces, video-first layout. Clean and professional without being corporate.",
    source: { path: "design-systems/loom" },
  },
  {
    id: "design-system:lovable",
    kind: "design-system",
    name: "Lovable",
    description:
      "AI full-stack builder. Playful gradients, friendly dev aesthetic.",
    source: { path: "design-systems/lovable" },
  },
  {
    id: "design-system:luxury",
    kind: "design-system",
    name: "Luxury",
    description:
      "High-end dark aesthetic with bold headings, monochromatic palette, and premium feel for luxury brand experiences.",
    source: { path: "design-systems/luxury" },
  },
  {
    id: "design-system:mastercard",
    kind: "design-system",
    name: "Mastercard",
    description:
      "Global payments network. Warm cream canvas, orbital pill shapes, editorial warmth.",
    source: { path: "design-systems/mastercard" },
  },
  {
    id: "design-system:material",
    kind: "design-system",
    name: "Material",
    description:
      "Google's Material Design with layered surfaces, dynamic theming, built-in motion, and responsive cross-platform patterns.",
    source: { path: "design-systems/material" },
  },
  {
    id: "design-system:meta",
    kind: "design-system",
    name: "Meta",
    description:
      "Tech retail store. Photography-first, binary light/dark surfaces, Meta Blue CTAs.",
    source: { path: "design-systems/meta" },
  },
  {
    id: "design-system:minimal",
    kind: "design-system",
    name: "Minimal",
    description:
      "Stripped-back design emphasizing whitespace, clean typography, and restrained color for maximum clarity and focus.",
    source: { path: "design-systems/minimal" },
  },
  {
    id: "design-system:minimax",
    kind: "design-system",
    name: "Minimax",
    description: "AI model provider. Bold dark interface with neon accents.",
    source: { path: "design-systems/minimax" },
  },
  {
    id: "design-system:mintlify",
    kind: "design-system",
    name: "Mintlify",
    description:
      "Documentation platform. Clean, green-accented, reading-optimized.",
    source: { path: "design-systems/mintlify" },
  },
  {
    id: "design-system:miro",
    kind: "design-system",
    name: "Miro",
    description:
      "Visual collaboration. Bright yellow accent, infinite canvas aesthetic.",
    source: { path: "design-systems/miro" },
  },
  {
    id: "design-system:mission-control",
    kind: "design-system",
    name: "Mission Control",
    description:
      "Space/aerospace mission monitoring. Dark command center, amber telemetry, monospace precision. Functional clarity above all else.",
    source: { path: "design-systems/mission-control" },
  },
  {
    id: "design-system:mistral-ai",
    kind: "design-system",
    name: "Mistral AI",
    description:
      "Open-weight LLM provider. French-engineered minimalism, purple-toned.",
    source: { path: "design-systems/mistral-ai" },
  },
  {
    id: "design-system:modern",
    kind: "design-system",
    name: "Modern",
    description:
      "Contemporary editorial style with serif typography, minimal palettes, and clean layouts for polished digital products.",
    source: { path: "design-systems/modern" },
  },
  {
    id: "design-system:mongodb",
    kind: "design-system",
    name: "Mongodb",
    description:
      "Document database. Green leaf branding, developer documentation focus.",
    source: { path: "design-systems/mongodb" },
  },
  {
    id: "design-system:neobrutalism",
    kind: "design-system",
    name: "Neobrutalism",
    description:
      "Modern take on brutalism with bold borders, vivid accent colors, and raw, high-contrast layouts on warm surfaces.",
    source: { path: "design-systems/neobrutalism" },
  },
  {
    id: "design-system:neon",
    kind: "design-system",
    name: "Neon",
    description:
      "Electric neon glow effects with high-contrast color pairings for bold, attention-grabbing interfaces.",
    source: { path: "design-systems/neon" },
  },
  {
    id: "design-system:neumorphism",
    kind: "design-system",
    name: "Neumorphism",
    description:
      "Soft, extruded UI elements with inner and outer shadows on monochromatic surfaces for a tactile, embedded look.",
    source: { path: "design-systems/neumorphism" },
  },
  {
    id: "design-system:nike",
    kind: "design-system",
    name: "Nike",
    description:
      "Athletic retail. Monochrome UI, massive uppercase type, full-bleed photography.",
    source: { path: "design-systems/nike" },
  },
  {
    id: "design-system:notion",
    kind: "design-system",
    name: "Notion",
    description:
      "All-in-one workspace. Warm minimalism, serif headings, soft surfaces.",
    source: { path: "design-systems/notion" },
  },
  {
    id: "design-system:nvidia",
    kind: "design-system",
    name: "Nvidia",
    description:
      "GPU computing. Green-black energy, technical power aesthetic.",
    source: { path: "design-systems/nvidia" },
  },
  {
    id: "design-system:ollama",
    kind: "design-system",
    name: "Ollama",
    description: "Run LLMs locally. Terminal-first, monochrome simplicity.",
    source: { path: "design-systems/ollama" },
  },
  {
    id: "design-system:openai",
    kind: "design-system",
    name: "Openai",
    description:
      "Calm, near-monochrome system anchored in deep teal-black with generous white space and editorial typography.",
    source: { path: "design-systems/openai" },
  },
  {
    id: "design-system:opencode-ai",
    kind: "design-system",
    name: "Opencode AI",
    description: "AI coding platform. Developer-centric dark theme.",
    source: { path: "design-systems/opencode-ai" },
  },
  {
    id: "design-system:pacman",
    kind: "design-system",
    name: "Pacman",
    description:
      "Retro arcade-inspired design with pixel fonts, dotted borders, playful high-contrast colors, and 8-bit game aesthetics.",
    source: { path: "design-systems/pacman" },
  },
  {
    id: "design-system:paper",
    kind: "design-system",
    name: "Paper",
    description:
      "Paper-textured, print-inspired design with minimal colors, clean serif/sans typography, and tactile surface qualities.",
    source: { path: "design-systems/paper" },
  },
  {
    id: "color-system:bauhaus-primary",
    kind: "color-system",
    name: "Bauhaus Primary",
    description: "Color tokens for the Bauhaus Primary presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/bauhaus-primary",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemBauhausPrimary,
    ),
  },
  {
    id: "color-system:berry-pop",
    kind: "color-system",
    name: "Berry Pop",
    description: "Color tokens for the Berry Pop presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/berry-pop",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemBerryPop,
    ),
  },
  {
    id: "color-system:carnival",
    kind: "color-system",
    name: "Carnival",
    description: "Color tokens for the Carnival presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/carnival",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemCarnival,
    ),
  },
  {
    id: "color-system:citrus-fresh",
    kind: "color-system",
    name: "Citrus Fresh",
    description: "Color tokens for the Citrus Fresh presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/citrus-fresh",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemCitrusFresh,
    ),
  },
  {
    id: "color-system:coral-studio",
    kind: "color-system",
    name: "Coral Studio",
    description: "Color tokens for the Coral Studio presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/coral-studio",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemCoralStudio,
    ),
  },
  {
    id: "color-system:forest-editorial",
    kind: "color-system",
    name: "Forest Editorial",
    description: "Color tokens for the Forest Editorial presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/forest-editorial",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemForestEditorial,
    ),
  },
  {
    id: "color-system:gold-luxe",
    kind: "color-system",
    name: "Gold Luxe",
    description: "Color tokens for the Gold Luxe presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/gold-luxe",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemGoldLuxe,
    ),
  },
  {
    id: "color-system:mauve-dusk",
    kind: "color-system",
    name: "Mauve Dusk",
    description: "Color tokens for the Mauve Dusk presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/mauve-dusk",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemMauveDusk,
    ),
  },
  {
    id: "color-system:midnight-mono",
    kind: "color-system",
    name: "Midnight Mono",
    description: "Color tokens for the Midnight Mono presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/midnight-mono",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemMidnightMono,
    ),
  },
  {
    id: "color-system:mint-tech",
    kind: "color-system",
    name: "Mint Tech",
    description: "Color tokens for the Mint Tech presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/mint-tech",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemMintTech,
    ),
  },
  {
    id: "color-system:mono-ink",
    kind: "color-system",
    name: "Mono Ink",
    description: "Color tokens for the Mono Ink presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/mono-ink",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemMonoInk,
    ),
  },
  {
    id: "color-system:nordic-frost",
    kind: "color-system",
    name: "Nordic Frost",
    description: "Color tokens for the Nordic Frost presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/nordic-frost",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemNordicFrost,
    ),
  },
  {
    id: "color-system:ocean-deep",
    kind: "color-system",
    name: "Ocean Deep",
    description: "Color tokens for the Ocean Deep presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/ocean-deep",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemOceanDeep,
    ),
  },
  {
    id: "color-system:pop-art",
    kind: "color-system",
    name: "Pop Art",
    description: "Color tokens for the Pop Art presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/pop-art",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemPopArt,
    ),
  },
  {
    id: "color-system:prism",
    kind: "color-system",
    name: "Prism",
    description: "Color tokens for the Prism presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/prism",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemPrism,
    ),
  },
  {
    id: "color-system:slate-corporate",
    kind: "color-system",
    name: "Slate Corporate",
    description: "Color tokens for the Slate Corporate presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/slate-corporate",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemSlateCorporate,
    ),
  },
  {
    id: "color-system:sunset-maroon",
    kind: "color-system",
    name: "Sunset Maroon",
    description: "Color tokens for the Sunset Maroon presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/sunset-maroon",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemSunsetMaroon,
    ),
  },
  {
    id: "color-system:terracotta-clay",
    kind: "color-system",
    name: "Terracotta Clay",
    description: "Color tokens for the Terracotta Clay presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/terracotta-clay",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemTerracottaClay,
    ),
  },
  {
    id: "color-system:warm-sand",
    kind: "color-system",
    name: "Warm Sand",
    description: "Color tokens for the Warm Sand presentation palette.",
    source: privateR2ArchiveSource(
      "presentation-color-system/warm-sand",
      PRESENTATION_RESOURCE_ARCHIVE_SHA256.colorSystemWarmSand,
    ),
  },
  {
    id: "design-system:perplexity",
    kind: "design-system",
    name: "Perplexity",
    description:
      "Conversational AI search engine. Deep-dark canvas, sharp typography, single violet accent, dense information hierarchy.",
    source: { path: "design-systems/perplexity" },
  },
  {
    id: "design-system:perspective",
    kind: "design-system",
    name: "Perspective",
    description:
      "Spatial depth design with isometric views, vanishing points, and layered elements that guide attention through 3D-like realism.",
    source: { path: "design-systems/perspective" },
  },
  {
    id: "design-system:pinterest",
    kind: "design-system",
    name: "Pinterest",
    description: "Visual discovery. Red accent, masonry grid, image-first.",
    source: { path: "design-systems/pinterest" },
  },
  {
    id: "design-system:playstation",
    kind: "design-system",
    name: "Playstation",
    description:
      "Gaming console retail. Three-surface channel layout, quiet-authority display type, cyan hover-scale.",
    source: { path: "design-systems/playstation" },
  },
  {
    id: "design-system:posthog",
    kind: "design-system",
    name: "Posthog",
    description:
      "Product analytics. Playful hedgehog branding, developer-friendly dark UI.",
    source: { path: "design-systems/posthog" },
  },
  {
    id: "design-system:premium",
    kind: "design-system",
    name: "Premium",
    description:
      "Apple-inspired premium aesthetic with precise spacing, modern typography, and a refined, polished visual language.",
    source: { path: "design-systems/premium" },
  },
  {
    id: "design-system:professional",
    kind: "design-system",
    name: "Professional",
    description:
      "Polished, business-ready design with modern typography, structured layouts, and a trustworthy visual identity.",
    source: { path: "design-systems/professional" },
  },
  {
    id: "design-system:publication",
    kind: "design-system",
    name: "Publication",
    description:
      "Print-inspired visual language for books, magazines, and reports with editorial grids and expressive typography.",
    source: { path: "design-systems/publication" },
  },
  {
    id: "design-system:raycast",
    kind: "design-system",
    name: "Raycast",
    description:
      "Productivity launcher. Sleek dark chrome, vibrant gradient accents.",
    source: { path: "design-systems/raycast" },
  },
  {
    id: "design-system:refined",
    kind: "design-system",
    name: "Refined",
    description:
      "Carefully curated, modern minimal style with elegant serif typography and understated, sophisticated palettes.",
    source: { path: "design-systems/refined" },
  },
  {
    id: "design-system:renault",
    kind: "design-system",
    name: "Renault",
    description:
      "French automotive. Vibrant aurora gradients, NouvelR typography, bold energy.",
    source: { path: "design-systems/renault" },
  },
  {
    id: "design-system:replicate",
    kind: "design-system",
    name: "Replicate",
    description: "Run ML models via API. Clean white canvas, code-forward.",
    source: { path: "design-systems/replicate" },
  },
  {
    id: "design-system:resend",
    kind: "design-system",
    name: "Resend",
    description: "Email API. Minimal dark theme, monospace accents.",
    source: { path: "design-systems/resend" },
  },
  {
    id: "design-system:retro",
    kind: "design-system",
    name: "Retro",
    description:
      "Throwback design with vintage-inspired typography, high-contrast retro palettes, and nostalgic visual elements.",
    source: { path: "design-systems/retro" },
  },
  {
    id: "design-system:revolut",
    kind: "design-system",
    name: "Revolut",
    description:
      "Digital banking. Sleek dark interface, gradient cards, fintech precision.",
    source: { path: "design-systems/revolut" },
  },
  {
    id: "design-system:runwayml",
    kind: "design-system",
    name: "Runwayml",
    description: "AI video generation. Cinematic dark UI, media-rich layout.",
    source: { path: "design-systems/runwayml" },
  },
  {
    id: "design-system:sanity",
    kind: "design-system",
    name: "Sanity",
    description: "Headless CMS. Red accent, content-first editorial layout.",
    source: { path: "design-systems/sanity" },
  },
  {
    id: "design-system:sentry",
    kind: "design-system",
    name: "Sentry",
    description:
      "Error monitoring. Dark dashboard, data-dense, pink-purple accent.",
    source: { path: "design-systems/sentry" },
  },
  {
    id: "design-system:shadcn",
    kind: "design-system",
    name: "Shadcn",
    description:
      "Shadcn/ui-inspired design with minimal, clean components, monochrome palette, and utility-first patterns.",
    source: { path: "design-systems/shadcn" },
  },
  {
    id: "design-system:shopify",
    kind: "design-system",
    name: "Shopify",
    description:
      "E-commerce platform. Dark-first cinematic, neon green accent, ultra-light type.",
    source: { path: "design-systems/shopify" },
  },
  {
    id: "design-system:simple",
    kind: "design-system",
    name: "Simple",
    description:
      "Straightforward, no-frills design with clean typography, neutral colors, and intuitive layouts that stay out of the way.",
    source: { path: "design-systems/simple" },
  },
  {
    id: "design-system:skeumorphism",
    kind: "design-system",
    name: "Skeumorphism",
    description:
      "Real-world mimicry with textured surfaces, 3D effects, and familiar physical metaphors for intuitive digital interfaces.",
    source: { path: "design-systems/skeumorphism" },
  },
  {
    id: "design-system:slack",
    kind: "design-system",
    name: "Slack",
    description:
      "Workplace communication platform. Aubergine-primary, multi-accent logo palette, light surfaces with dark sidebar, warm and approachable.",
    source: { path: "design-systems/slack" },
  },
  {
    id: "design-system:sleek",
    kind: "design-system",
    name: "Sleek",
    description:
      "Modern minimalist aesthetic with clean lines, intentional color palette, subtle interactions, and consistent spacing.",
    source: { path: "design-systems/sleek" },
  },
  {
    id: "design-system:spacex",
    kind: "design-system",
    name: "Spacex",
    description:
      "Space technology. Stark black and white, full-bleed imagery, futuristic.",
    source: { path: "design-systems/spacex" },
  },
  {
    id: "design-system:spacious",
    kind: "design-system",
    name: "Spacious",
    description:
      "Generous whitespace, consistent padding, and grid-based layouts for clean, readable, and breathing interfaces.",
    source: { path: "design-systems/spacious" },
  },
  {
    id: "design-system:spotify",
    kind: "design-system",
    name: "Spotify",
    description:
      "Music streaming. Vibrant green on dark, bold type, album-art-driven.",
    source: { path: "design-systems/spotify" },
  },
  {
    id: "design-system:starbucks",
    kind: "design-system",
    name: "Starbucks",
    description:
      "Global coffee retail brand. Four-tier green system, warm cream canvas, full-pill buttons.",
    source: { path: "design-systems/starbucks" },
  },
  {
    id: "design-system:storytelling",
    kind: "design-system",
    name: "Storytelling",
    description:
      "Narrative-driven design using visuals, copy, and interaction to guide users through engaging, emotionally resonant journeys.",
    source: { path: "design-systems/storytelling" },
  },
  {
    id: "design-system:stripe",
    kind: "design-system",
    name: "Stripe",
    description:
      "Payment infrastructure. Signature purple gradients, weight-300 elegance.",
    source: { path: "design-systems/stripe" },
  },
  {
    id: "design-system:supabase",
    kind: "design-system",
    name: "Supabase",
    description:
      "Open-source Firebase alternative. Dark emerald theme, code-first.",
    source: { path: "design-systems/supabase" },
  },
  {
    id: "design-system:superhuman",
    kind: "design-system",
    name: "Superhuman",
    description:
      "Fast email client. Premium dark UI, keyboard-first, purple glow.",
    source: { path: "design-systems/superhuman" },
  },
  {
    id: "design-system:tesla",
    kind: "design-system",
    name: "Tesla",
    description:
      "Electric automotive. Radical subtraction, full-viewport photography, near-zero UI.",
    source: { path: "design-systems/tesla" },
  },
  {
    id: "design-system:tetris",
    kind: "design-system",
    name: "Tetris",
    description:
      "Classic block-game inspired design with playful colors, bold display fonts, and compact, high-energy layouts.",
    source: { path: "design-systems/tetris" },
  },
  {
    id: "design-system:theverge",
    kind: "design-system",
    name: "Theverge",
    description:
      "Tech editorial media. Acid-mint and ultraviolet accents, Manuka display, rave-flyer story tiles.",
    source: { path: "design-systems/theverge" },
  },
  {
    id: "design-system:together-ai",
    kind: "design-system",
    name: "Together AI",
    description:
      "Open-source AI infrastructure. Technical, blueprint-style design.",
    source: { path: "design-systems/together-ai" },
  },
  {
    id: "design-system:totality-festival",
    kind: "design-system",
    name: "Totality Festival",
    description:
      'A cosmic-premium, glassmorphic dark system that captures the visceral awe of a solar eclipse — obsidian surfaces, amber "corona" highlights, and cyan atmospheric accents.',
    source: { path: "design-systems/totality-festival" },
  },
  {
    id: "design-system:uber",
    kind: "design-system",
    name: "Uber",
    description:
      "Mobility platform. Bold black and white, tight type, urban energy.",
    source: { path: "design-systems/uber" },
  },
  {
    id: "design-system:urdu",
    kind: "design-system",
    name: "Urdu",
    description:
      "Urdu-first digital experiences with native RTL support,Nastaliq typography, and bilingual harmony.",
    source: { path: "design-systems/urdu" },
  },
  {
    id: "design-system:vercel",
    kind: "design-system",
    name: "Vercel",
    description: "Frontend deployment. Black and white precision, Geist font.",
    source: { path: "design-systems/vercel" },
  },
  {
    id: "design-system:vibrant",
    kind: "design-system",
    name: "Vibrant",
    description:
      "Lively, colorful design with bold playful typography, warm accents, and dynamic visual energy.",
    source: { path: "design-systems/vibrant" },
  },
  {
    id: "design-system:vintage",
    kind: "design-system",
    name: "Vintage",
    description:
      "1950s-1990s nostalgia with skeuomorphic touches, grainy textures, retro color palettes, and pixel-style typography.",
    source: { path: "design-systems/vintage" },
  },
  {
    id: "design-system:vodafone",
    kind: "design-system",
    name: "Vodafone",
    description:
      "Global telecom brand. Monumental uppercase display, Vodafone Red chapter bands.",
    source: { path: "design-systems/vodafone" },
  },
  {
    id: "design-system:voltagent",
    kind: "design-system",
    name: "Voltagent",
    description:
      "AI agent framework. Void-black canvas, emerald accent, terminal-native.",
    source: { path: "design-systems/voltagent" },
  },
  {
    id: "design-system:warp",
    kind: "design-system",
    name: "Warp",
    description:
      "Modern terminal. Dark IDE-like interface, block-based command UI.",
    source: { path: "design-systems/warp" },
  },
  {
    id: "design-system:webex",
    kind: "design-system",
    name: "Webex",
    description:
      "Collaboration platform. Momentum typography, blue action system, multi-user accent spectrum.",
    source: { path: "design-systems/webex" },
  },
  {
    id: "design-system:webflow",
    kind: "design-system",
    name: "Webflow",
    description:
      "Visual web builder. Blue-accented, polished marketing site aesthetic.",
    source: { path: "design-systems/webflow" },
  },
  {
    id: "design-system:wechat",
    kind: "design-system",
    name: "Wechat",
    description:
      "Brand visual language for WeChat Mini Programs, official accounts, and open ecosystem extensions.",
    source: { path: "design-systems/wechat" },
  },
  {
    id: "design-system:wired",
    kind: "design-system",
    name: "Wired",
    description:
      "Tech magazine. Paper-white broadsheet density, custom serif display, mono kickers, ink-blue links.",
    source: { path: "design-systems/wired" },
  },
  {
    id: "design-system:wise",
    kind: "design-system",
    name: "Wise",
    description: "Money transfer. Bright green accent, friendly and clear.",
    source: { path: "design-systems/wise" },
  },
  {
    id: "design-system:x-ai",
    kind: "design-system",
    name: "X AI",
    description: "Elon Musk's AI lab. Stark monochrome, futuristic minimalism.",
    source: { path: "design-systems/x-ai" },
  },
  {
    id: "design-system:xiaohongshu",
    kind: "design-system",
    name: "Xiaohongshu",
    description:
      "Lifestyle UGC social platform. Singular brand red, generous radius, content-first.",
    source: { path: "design-systems/xiaohongshu" },
  },
  {
    id: "design-system:zapier",
    kind: "design-system",
    name: "Zapier",
    description:
      "Automation platform. Warm orange, friendly illustration-driven.",
    source: { path: "design-systems/zapier" },
  },
  {
    id: "image-style:emboss-deboss",
    kind: "image-style",
    name: "Emboss & Deboss",
    description:
      "Poetic paper posters with pronounced raised lettering and forms, deep pressed contours, fine fibers, and intentional negative space.",
    desc: "Poetic editorial posters and covers in sculpted matte paper, with pronounced raised lettering and forms, deeply pressed contours, fine fibers, and intentional negative space. Use for /emboss-deboss, embossed paper posters, debossed typography, letterpress covers, or paper-relief design.",
    source: imageStyleSource("emboss-deboss"),
  },
  {
    id: "image-style:notion-illustration",
    kind: "image-style",
    name: "Notion Illustration",
    description:
      "Hand-drawn product spot illustration style with simple ink contours and soft backgrounds.",
    desc: 'Notion-editorial-style hand-drawn spot illustration. Black brush-pen ink on white, tapered confident strokes, solid-black curly hair, solid-black pants/shoes, 3/4 face turned toward viewer with closed-eye smile and soft nose hint, open breathing body outlines, and 1-3 supporting scene props + ambient marks that frame the moment. Trigger when user says /notion-illustration, asks for a "Notion-style illustration", "Notion spot illustration", or a new piece in this hand-drawn brush-pen Notion editorial style.',
    source: imageStyleSource("notion-illustration"),
  },
  {
    id: "image-style:vm0-illustration",
    kind: "image-style",
    name: "Okou Illustration",
    description:
      "Okou in-app spot illustration style with bold hand-drawn ink line art, white-filled interiors, and a soft rounded color backdrop.",
    desc: "Generate Okou in-app spot illustrations: bold hand-drawn ink line art with white-filled interiors, a soft rounded color backdrop, transparent output, and simple iconic metaphors for product states.",
    source: imageStyleSource("vm0-illustration"),
  },
  {
    id: "image-style:postcard-illustration",
    kind: "image-style",
    name: "Postcard Illustration",
    description:
      "Hand-drawn editorial postcard / travel-journal illustration with fine black ink linework, flat saturated gouache fills, sharp edges, dense small repeated ink patterns, paper-grain texture, sparse white speckles, and a tall portrait composition.",
    desc: 'Hand-drawn editorial postcard illustration style. Fine black marker/pen ink linework over flat saturated gouache color fills with sharp edges, dense small repeated ink patterns on surfaces (rows of windows, shingle curves, hatching, stippling), subtle paper-grain background texture, tiny scattered white speckles (snow / petals / sparkle), and a tall portrait composition with a layered foreground-midground-background. Travel-journal / urban-sketcher aesthetic. Trigger when the user says /postcard-illustration, asks for a "postcard illustration", "travel illustration", "urban sketcher style", or briefs a palette + scene archetype + complexity.',
    source: imageStyleSource("postcard-illustration"),
  },
  {
    id: "image-style:folk-storybook",
    kind: "image-style",
    name: "Folk Storybook Illustration",
    description:
      "Folk-art children's picture-book illustration — hand-painted gouache and watercolor scenes with anthropomorphic animal characters, closed-crescent-eye smiles, dusty muted folk palette, and decorative pattern surfaces.",
    desc: "Folk-art children's picture-book illustration style — hand-painted gouache/watercolor scene on aged paper, anthropomorphic animal characters with closed-crescent-eye smiles, dusty muted folk palette, decorative pattern surfaces (wallpaper, rugs, textiles), and a hushed lullaby mood. Trigger when users ask for a folk-art illustration, storybook scene, cozy animal illustration, or any new piece in this Eastern European picture-book style.",
    source: imageStyleSource("folk-storybook"),
  },
  {
    id: "image-style:papernook",
    kind: "image-style",
    name: "Papernook",
    description:
      "Hand-drawn editorial illustration set in a cozy cluttered personal-studio scene with warm cream paper, scratchy ink, painterly gouache fills, dot-eye character face, and dense edge-to-edge thematic props.",
    desc: 'Hand-drawn editorial illustration in the spirit of a cluttered personal-studio scene. Loose scratchy black ink outlines that wobble, textured gouache fills with visible brush marks, warm cream paper background, simplified dot-eye character face, and a DENSE edge-to-edge composition where a centered character is orbited by thematic props that visually act out the scene metaphor. Default palette: dusty cornflower blue, soft coral pink, fresh sage green, charcoal, warm cream — no mustard, no burnt-orange. Trigger when user says /papernook, asks for a "papernook illustration", a "cozy cluttered editorial scene", a "warm-cream desk scene", or a new piece in this hand-drawn studio-clutter editorial style.',
    source: imageStyleSource("papernook"),
  },
  {
    id: "image-style:painterly-botanical",
    kind: "image-style",
    name: "Painterly Botanical",
    description:
      "Painterly watercolor + gouache portrait illustration with a single figure embraced by lush botanicals, closed-eye introspective expression, and a softly tinted paper-wash background.",
    desc: 'Painterly watercolor + gouache portrait illustration. Single figure (closed eyes, contemplative) embraced by botanicals — leaves, blossoms, grasses. Translucent washes with visible pigment bleeds, sparse crisp ink line accents on key edges, tiny handwritten cursive signature in an upper corner, and a tinted paper-wash background (never pure white). Eight user axes drive composition: subject, hair, pose, botanicals, palette, background wash, complexity (L1/L2/L3), and format. Trigger when a brief describes a contemplative figure with foliage, a "watercolor portrait", a "botanical embrace", or asks for a piece in this painterly editorial style.',
    source: imageStyleSource("painterly-botanical"),
  },
  {
    id: "image-style:iso-scene",
    kind: "image-style",
    name: "Isometric Editorial Scene",
    description:
      "Isometric editorial-magazine scene illustration with ultra-fine hairline outlines, flat fills, a saturated monochromatic background, and a scene-as-metaphor composition built from theme-native props.",
    desc: 'Isometric editorial-magazine scene illustration in a locked flat-vector style — ultra-fine hairline outlines, monochromatic saturated background filling the canvas, and a single composed scene whose props themselves embody the theme. Trigger when users say /iso-scene, ask for an "isometric editorial illustration", a "scene illustration in the editorial machine style", or brief with palette + scene archetype + complexity.',
    source: imageStyleSource("iso-scene"),
  },
  {
    id: "image-style:inkdab",
    kind: "image-style",
    name: "Inkdab Illustration",
    description:
      "Brush-pen editorial illustration where a free-floating color dab is painted first, then loose black ink linework is drawn freely on top — never as an outline around the color. Scribbled hatched hair, open-outline bodies, pure white background.",
    desc: 'Brush-pen editorial illustration style — a flat accent-color "dab" painted first, then loose black ink drawn freely on top. ONE flat accent-color shape per prop (painted-first, never outlined in black), black hand-wobbled ink on pure white background, scribbled hatched hair, open-outline bodies with zero fill, and one small solid-accent triangle floating freely as a recurring motif. Trigger when user says /inkdab, asks for an "inkdab illustration", a "brush-pen illustration with a single accent color", a "free-floating color block illustration", or briefs in the style of the included reference images.',
    source: imageStyleSource("inkdab"),
  },
  {
    id: "image-style:riso-relic",
    kind: "image-style",
    name: "Riso Relic",
    description:
      'Pop-art retro risograph poster of a single nostalgic everyday object on a saturated single-hue field — bold black ink outlines, halftone grain, hand-drawn doodle accents, tiny "SMALL OBJECTS IN TIME" banner up top, chunky retro headline with offset drop-shadow at the bottom.',
    desc: 'Pop-art retro risograph poster of a single nostalgic everyday object — saturated single-color background, bold black ink outlines, halftone/riso grain, hand-drawn doodle accents (sparkles, squiggles, dots, music notes, lightning), tiny white "SMALL OBJECTS IN TIME" banner at top, chunky retro display headline at bottom with offset black drop-shadow. Trigger when user says /riso-relic, asks for a "riso poster", a "small objects in time" illustration, or any new piece in this nostalgic pop-art relic-object style.',
    source: imageStyleSource("riso-relic"),
  },
  {
    id: "image-style:inkstomp",
    kind: "image-style",
    name: "Inkstomp",
    description:
      "Loud indie-packaging poster style — full-bleed saturated flat color, a two-line hand-lettered headline, and one weird-cute black brush-ink character.",
    desc: 'Inkstomp — a loud, hand-screened indie-packaging poster style. Full-bleed saturated flat color filling the entire canvas, a two-line hand-lettered headline (thin arched caps over chunky drop-shadowed display), and one weird-cute character drawn in thick uniform black brush ink. Trigger when the user says /inkstomp, asks for an "inkstomp poster", a "Ray Fenwick / Hattie Stewart packaging poster", an "indie brush-ink flavor card", or briefs in a "palette + headline + character" shape.',
    source: imageStyleSource("inkstomp"),
  },
  {
    id: "image-style:folk-muse",
    kind: "image-style",
    name: "Folk Muse",
    description:
      "Flat folk-art gouache portrait style — a single contemplative chest-up figure framed by an asymmetric botanical surround, with painted irises, smooth flat hair, a hand against the cheek, and a patterned robe.",
    desc: 'Flat folk-art gouache portrait illustration in the contemporary editorial style of Carson Ellis, Maja Tomljanovic, and Bodil Jane. A single chest-up figure with an elongated mannerist oval face, tiny almond half-lidded eyes, smooth flat hair, one hand pressed against the face, a patterned robe filling the lower frame, and an asymmetric botanical surround filling the background edge-to-edge. Hand-painted matte gouache texture, flat color blocks, no harsh outlines, no photorealism. Calm, slightly melancholic, contemplative mood. Trigger when the user says /folk-muse, asks for a "folk-art portrait", "gouache portrait", "Carson Ellis style portrait", or any new piece in this contemplative folk-portrait style.',
    source: imageStyleSource("folk-muse"),
  },
  {
    id: "image-style:sunlit-gouache",
    kind: "image-style",
    name: "Sunlit Gouache",
    description:
      "Bright pastel travel-painting illustration in opaque gouache on textured paper with chunky flat brushstrokes, vertical one-point perspective, and figures walking into warm sunlight.",
    desc: 'Sunlit Gouache travel-painting illustration. Opaque gouache on textured paper, visible chunky flat brushstrokes with dry-brush highlights, locked six-color palette (cream, butter-yellow, sky-blue, sage-green, terracotta, one small red accent), vertical 2:3 one-point-perspective composition drawing the eye into a bright sunlit focal point, figures seen from behind walking into the scene, an overhead band of hanging elements (awning, prayer flags, catenary, bunting, lanterns) creating depth, dappled painterly reflections on the ground, airy optimistic warm mood. Trigger when user says /sunlit-gouache, asks for a "sunlit gouache illustration", "painterly travel scene", "gouache café/market/temple/station scene", or a new piece in this bright pastel painted-light style.',
    source: imageStyleSource("sunlit-gouache"),
  },
  {
    id: "image-style:mosaic-still-life",
    kind: "image-style",
    name: "Mosaic Still Life",
    description:
      "Editorial still-life illustration in a mosaic-tile + painterly hybrid style — tessellated ground/sky/wall surfaces with crisp painterly objects, an animal companion, and a patterned textile peeking through.",
    desc: 'Mosaic-tile + painterly hybrid editorial illustration. Tessellated/pointillist mosaic surfaces (grass, sky, sand, walls, floors) anchor the scene, with crisp painterly still-life objects rendered ON TOP. Always features a still-life centerpiece on a table, an animal companion at the heart of the scene, and at least one patterned textile peeking through. Cozy, nostalgic, bucolic mood. Trigger when user says /mosaic-still-life, asks for a "mosaic illustration", "mosaic-tile editorial illustration", "tessellated still life", or briefs with a palette + scene + animal in this style.',
    source: imageStyleSource("mosaic-still-life"),
  },
  {
    id: "image-style:ink-mascot",
    kind: "image-style",
    name: "Ink Mascot",
    description:
      "Vintage editorial marketing card. Bold serif headline and short serif descriptor over a hand-drawn black-ink anthropomorphic mascot (stick limbs, chunky white sneakers) on a single solid saturated flat color background.",
    desc: 'Generate a 3:5 portrait editorial marketing card in a locked vintage-textbook style. Bold serif headline plus an optional short serif descriptor sit on a single solid saturated flat color background (no gradient, no divider, no ground line). A hand-drawn black-ink anthropomorphic hero object — paint bucket, magnifying glass, envelope, notebook, funnel, megaphone, rocket, seedling, gift box, compass, etc. — stands with two thin stick arms, two stick legs, and chunky white sneakers with black laces (the signature detail). Crosshatch and stipple shading on rounded surfaces; floating ink doodles (sparkles, arrows, hearts, percent or dollar signs, motion lines) at the requested density. Dialable along six axes: concept, palette, hero object, action, doodle density (L1 minimal, L2 balanced, L3 packed), and type layout (A title-top, B headline-bottom, C headline-only, D big-word + tiny-descriptor). Trigger when user says /ink-mascot, asks for a "marketing card illustration", a "retro editorial mascot poster", or briefs with a marketing concept plus palette plus character.',
    source: imageStyleSource("ink-mascot"),
  },
  {
    id: "image-style:sticker-sheet",
    kind: "image-style",
    name: "Sticker Sheet",
    description:
      "Hand-painted gouache sticker-sheet illustration with ~20 themed objects floating on white, punchy saturated palette, wobbly hand-drawn ink overlay, and tiny decorative marks on every item.",
    desc: 'Sticker Sheet — hand-painted gouache sticker-sheet illustration. ~20 small floating themed objects on pure white, punchy saturated palette (coral, mustard, sage, dusty pink, navy, cream, warm brown), flat brushy gouache fills with wobbly hand-drawn ink linework and tiny decorative marks (dots, hatches, squiggles) on every object. Each object slightly tilted, no drop shadows, cheerful cozy lifestyle journal mood. Trigger when user says /sticker-sheet, asks for a "sticker sheet illustration", "hand-painted gouache sticker pack", "themed object sheet", or briefs with a scene theme + object count in this house style.',
    source: imageStyleSource("sticker-sheet"),
  },
  {
    id: "image-style:flat-poster",
    kind: "image-style",
    name: "Flat Poster",
    description:
      "Vertical flat-color editorial poster style — saturated solid background, one centered hand-drawn vector subject in bold deep-navy outlines with strict two-tone fill, headline pinned top-left, and an optional user-supplied wordmark pinned bottom-right.",
    desc: 'Flat Poster — a vertical flat-color editorial poster style for brand benefit cards, marketing posters, and in-app campaign visuals. Portrait 2:3 canvas filled edge-to-edge with one saturated hue; a single centered hand-drawn vector subject in deep-navy outlines with strict two-tone fill (pure white plus one darker bg-tint accent); a bold rounded sans-serif headline pinned top-left; an optional short wordmark supplied by the user pinned bottom-right and omitted when none is supplied; small floating accent marks around the subject; no body copy. Six creative dials: palette, subject archetype, composition preset, accent marks, headline voice, mood. Trigger when the user says /flat-poster, asks for a "flat-color editorial poster", a "brand benefit card", a "marketing card in the bold outline + flat color style", or briefs with a palette + subject + headline shape.',
    source: imageStyleSource("flat-poster"),
  },
  {
    id: "image-style:mellow-pop",
    kind: "image-style",
    name: "Mellow Pop",
    description:
      "Chill flat-vector editorial poster of a serene recurring character on a fully saturated solid color background, with a signature pop of bright leaf-green and a scene-as-metaphor composition.",
    desc: 'Mellow-pop flat-vector editorial illustration: a recurring chill character with closed-eye smile, tiny nose hint, and short dark bobbed hair, posed inside a scene-as-metaphor composition on a single fully saturated solid color background, with a signature pop of bright leaf-green woven into every piece (hero prop, plants, motifs, or sweater). Thin uniform black outlines, flat solid fills only, no gradients or texture. Five dials per brief: palette, scene metaphor, complexity (L1/L2/L3), pose, outfit accent. Trigger when user says /mellow-pop, asks for a "mellow-pop illustration", "chill flat-vector poster", or briefs with a scene metaphor + palette + complexity.',
    source: imageStyleSource("mellow-pop"),
  },
  {
    id: "image-style:grainy-duotone",
    kind: "image-style",
    name: "Grainy Duotone",
    description:
      "Editorial spot illustration on a warm cream background — grainy charcoal-stippled hands, outline-free flat two-tone color blocks with internal patterns, and scattered ambient marks.",
    desc: 'Grainy-duotone editorial spot illustration: warm cream off-white background, grainy charcoal-stippled hands (and occasional faces) drawn in textured black ink, paired with free-floating flat two-tone color blocks that carry NO outlines and are filled with internal patterns (grid, dots, spiral, hatching, squiggles, wavy lines), surrounded by scattered ambient marks (zigzags, triangles, x marks, circles, dashes). Square 1:1 scene-as-metaphor compositions. Five creative dials per brief: palette (two flat hues, e.g. teal+yellow / coral+sage / lavender+mustard / navy+peach / burgundy+dusty pink), elements (hand(s) + 1-3 props like flag, sprout, magnifier, balloons, ladder), scene archetype (Launch / Grow / Connect / Discover / Communicate / Reflect / Navigate / Care / Transform / Build), complexity (L1 minimal / L2 balanced / L3 rich), and mood (celebratory / calm / curious / reflective / determined / warm / quiet). Trigger when user says /grainy-duotone, asks for a "grainy two-tone editorial illustration", "charcoal-stippled hand illustration", "duotone editorial spot", or briefs with a scene metaphor + two-color palette + complexity.',
    source: imageStyleSource("grainy-duotone"),
  },
  {
    id: "image-style:op-ed-cover",
    kind: "image-style",
    name: "Op-Ed Cover",
    description:
      "Editorial magazine op-ed cover — flat-vector scene with paper grain, elongated ink-line characters, muted retro palette, and a serif headline block in the lower-right.",
    desc: 'Editorial magazine op-ed cover illustration. Flat-vector + paper-grain scene with expressive elongated ink-line characters, gentle painterly shading, 1950s-60s editorial mood, and a serif headline overlay block in the lower-right corner carrying a witty contrarian or declarative title with two short lines of italic body copy. 5-axis framework: palette (background + accent + ink), complexity (L1 single hero / L2 small ensemble / L3 busy crowd), scene metaphor (specific cultural microcosm), headline voice (declarative / pun / appreciative / contrarian), and headline block style (solid vs. translucent). Trigger when user says /op-ed-cover, asks for an "editorial magazine illustration", an "op-ed cover", a "magazine essay illustration", or a scene with a headline overlay in this style.',
    source: imageStyleSource("op-ed-cover"),
  },
  {
    id: "image-style:grain-poster",
    kind: "image-style",
    name: "Grain Poster",
    description:
      "Flat-vector editorial poster of a serene full-body figure with one hero prop — riso grain on a single textile, closed-eye smile + red cheek blush, muted limited palette.",
    desc: 'Grain Poster — flat-vector editorial illustration of a serene full-body figure interacting with one hero prop (bicycle, bouquet, cat, book, skateboard, sun hat, guitar, dog leash). Closed-eye smile + single round red cheek blush + dark nose mark + solid black hair, silhouette-first (no inked outlines). Riso/halftone grain confined to exactly ONE textile element (skirt or trousers); every other surface is flat color. Muted single-hue background, generous negative space, no headlines or wordmarks. Six tunable dials: palette (cool-dawn · sunset-coral · twilight · forest-green · custom), mood, scene, cast, complexity (L1/L2/L3), framing. Strongest at L1 + side-profile + solo. Trigger when user says /grain-poster, asks for a "flat-vector editorial poster", "riso-grain figure poster", "grainy editorial illustration", or briefs with a scene + palette + cast in this house style.',
    source: imageStyleSource("grain-poster"),
  },
  {
    id: "image-style:light-pop-portrait",
    kind: "image-style",
    name: "Light Pop Portrait",
    description:
      "Light hand-drawn flat-vector single-character portrait on a fully saturated color block — chunky black hair, big shiny eyes, tiny red nose, pink five-point-star sparkle blush.",
    desc: 'Light Pop Portrait — a hand-drawn flat-vector single-character portrait style for playful avatars, mood pieces, and editorial character cards. Square 1:1 canvas filled with one fully saturated background hue; a single child–tween character with chunky glossy-black hair (with one or two flyaway strands), big round shiny eyes (single white glint each, thin lashes above), tiny round red nose, expressive small mouth, and pink FIVE-POINT STAR sparkle blush on the cheeks (never solid dots). Thin delicate slightly-wavy hand-drawn contour lines, flat solid fills only, no gradients or texture, ~5-color palette per piece. Eight creative dials: expression, hairstyle, gender register, pose, palette, headwear, prop, outfit. Trigger when user says /light-pop-portrait, asks for a "light pop portrait", "flat-vector character portrait", "saturated color-block character", or briefs with expression + hairstyle + palette + prop.',
    source: imageStyleSource("light-pop-portrait"),
  },
  {
    id: "image-style:endpaper",
    kind: "image-style",
    name: "Endpaper",
    description:
      "Riso-grain flat-vector collection of chill characters or objects scattered across a saturated solid color field, with two-tone interior shading and closed-eye sleepy faces.",
    desc: 'Riso-grain flat-vector editorial collection illustration. Many small animals or objects scattered across a fully saturated solid color background — like the inside endpaper of a children\'s picture book. Subtle riso/screenprint grain inside every fill, two-tone interior shading on every character (darker top + lighter belly), closed crescent-eye sleepy smiles with tiny dot noses, NO outlines on character bodies, loose hand-drawn line details on props (yarn spirals, leaf veins, pot stripes), scattered curated composition where characters overlap and touch the canvas edges. Five dials: background hue, cast (cats/dogs/foxes/birds/sea-creatures/houseplants/kitchen-objects/etc.), character palette (3–5 curated fills), density (L1 sparse / L2 balanced / L3 packed), prop vocabulary matched to cast. Trigger when user says /endpaper, asks for an "endpaper illustration", a "scattered animal or object collection on saturated color", a "children\'s-book endpaper scene", or briefs with a cast + background hue + density + palette.',
    source: imageStyleSource("endpaper"),
  },
  {
    id: "image-style:editorial-flatfolk",
    kind: "image-style",
    name: "Editorial Flatfolk",
    description:
      "Editorial hand-drawn naive book-illustration style — flat saturated color blocks, loose ink line overlay, paper grain, and a strong sense of place.",
    desc: 'Editorial hand-drawn naive book-illustration style. Flat saturated color blocks with loose hand-drawn ink line work sitting ON TOP of the color, subtle paper grain across the canvas, simple ink hatching for sky / sun rays / rain / snow, and a strong sense of place built from tall narrow architecture and a one-point depth axis. Five dials per brief: palette (warm-primary, coastal-peach, jewel-night, winter-cool, autumn-rust, monsoon-twilight), scene metaphor (street, harbor, market, transit, park, square, interior, alpine-village), perspective (one-point street, frontal facade, low-angle hero, isometric, top-down), cast (solo wanderer, paired, small crowd, none), and light/weather (midday sun, golden hour, rain, snow, blue hour). Trigger when user says /editorial-flatfolk, asks for an "editorial flat-folk illustration", a "saturated naive book-illustration scene", a "tall narrow row-house illustration", or briefs a palette + scene metaphor + season.',
    source: imageStyleSource("editorial-flatfolk"),
  },
  {
    id: "image-style:soft-vector",
    kind: "image-style",
    name: "Soft Vector",
    description:
      "Airy flat-vector spot illustration — square pale-blue canvas, thin ~1.5-2px dark-navy linework with intentionally open / unclosed outlines, flat fills, one muted accent hue, centered subject with breathing room.",
    desc: 'Soft Vector — an airy flat-vector spot illustration style for in-app onboarding art, empty states, billing cards, and friendly UI moments. Square 1:1 canvas on a single flat pale-blue field #EEF1F5; thin uniform dark-navy outlines (~1.5-2px, rounded caps, NOT chunky); the signature lift comes from several intentionally OPEN / unclosed outlines per piece (mug rim gap, handle that doesn\'t close, ground line ending in mid-air, cloud silhouette break, lamp arm fade, pot rim gap); strictly flat colour fills with no gradients or shading; one muted lead accent (mustard / lime-sage / warm-orange / violet) plus neutrals; subject centered at ~60-75% of canvas with generous breathing room; scattered thin-navy micro-marks (dots, plus signs, sparkles, or motion ticks). Six dials per brief: palette accent, scene metaphor, complexity (L1/L2/L3), cast, accent marks, action/mood. Trigger when user says /soft-vector, asks for a "soft-vector illustration", a "friendly UI onboarding illustration", a "thin-line flat spot illustration", or briefs a scene metaphor + palette + complexity in this house style.',
    source: imageStyleSource("soft-vector"),
  },
  {
    id: "image-style:loose-contour",
    kind: "image-style",
    name: "Loose Contour",
    description:
      "Flat editorial spot illustration — open teal contour lines, offset color blobs (printing-misregistration look), one ribbon line on warm cream paper.",
    desc: 'Loose-contour flat editorial spot illustration: confident open-contour ink drawings in dark teal-green (#1e4d4a) over flat offset color blobs (printing-misregistration look) on warm cream paper (#f0ebdc), with exactly one continuous looping ribbon line of the same teal weaving through the scene. Tight 5-color palette: cream + teal + mustard + soft blue + coral. Lines are deliberately broken at joints and edges. Five dials per brief: scene metaphor, cast, complexity (L1/L2/L3), accent lead, ribbon path. Trigger when user says /loose-contour, asks for a "loose-contour illustration", "offset-blob editorial illustration", or "cream paper ribbon-line scene".',
    source: imageStyleSource("loose-contour"),
  },
  {
    id: "image-style:jade-blockprint",
    kind: "image-style",
    name: "Jade Blockprint",
    description:
      "Two-tone hand-drawn block-print spot illustration — accent color painted as free-floating shapes on white, with chunky black ink layered on top. Eight palettes.",
    desc: 'Jade-blockprint two-pass hand-drawn block-print spot illustration: one accent color painted FIRST as free-floating shapes on pure white, then chunky black ink line art layered ON TOP. Color blobs have no perimeter outline — ink draws detail, hatching, and motion marks, never traces the colored shape. Wobbly variable-weight linework with occasional flooded black masses; tiny linocut speckle grain inside color fills. Eight named palettes (jade, coral, cobalt, plum, sage, rose, slate, terracotta) plus custom-hex override. Resolves vague briefs (growth, trust, freedom, fairness) into concrete scene metaphors via an internal synthesizer table before generating. Five dials per piece: palette, scene metaphor, complexity (L1 single object / L2 mini-scene / L3 vignette), motion marks, speckle density. Trigger when the user says /jade-blockprint, asks for a "block-print illustration", "linocut spot illustration", "two-tone screen-print", or briefs a metaphor for a blog cover or marketing card in this style.',
    source: imageStyleSource("jade-blockprint"),
  },
  {
    id: "image-style:shadow-pop",
    kind: "image-style",
    name: "Shadow Pop",
    description:
      "Bright flat-vector illustration with offset black shape shadows, white dashed stitching, palette confetti, and transparent PNG output.",
    desc: 'Bright flat-vector editorial illustration style — every colored shape sits in front of an offset black silhouette of itself (the signature depth trick, no outlines on the fills), with white hand-drawn dashed stitching, scattered palette-colored sparkle confetti, and a fully transparent PNG background so the piece drops cleanly onto any surface. Five dials per brief — palette (default / berry-pop / tropical / citrus-cobalt), scene metaphor, complexity (L1 / L2 / L3), confetti density, and subject domain. Trigger when user says /shadow-pop, asks for a "shadow-pop illustration", a "bright flat-vector illustration with offset shadow", an "in-app illustration with offset shadow trick", or briefs in the style of the included reference images.',
    source: imageStyleSource("shadow-pop"),
  },
  {
    id: "image-style:tiny-wanderer",
    kind: "image-style",
    name: "Tiny Wanderer",
    description:
      "Contemplative bande-dessinée landscape illustration — tiny human dwarfed by vast nature, ink hatching + flat color, vertical portrait canvas.",
    desc: 'Contemplative bande-dessinée landscape illustration in a locked house style — a tiny human (or 2–3 figures) is dwarfed by a vast natural panorama, hand-drawn black ink contour + parallel/cross-hatching for clouds, rock walls, foliage, grass, and water texture, sitting on flat color blocks beneath the ink (no gradients, no airbrush). Restrained 3–5 color palette per piece including black ink, vertical portrait canvas (1024x1536, reads ~3:5). Always outdoor/wilderness. Moebius / Christophe Chabouté travel-sketchbook lineage, quiet wonder mood. Six dials per brief: palette family (sage-plains / sunset-warm / coastal-teal / cool-mist / autumn-rust / winter-pale / custom), landscape archetype (plains+clouds / mountain valley / river vista / rocky ridge / coastal cliffs / misty gorge / forest clearing / alpine pass / desert mesa / lakeshore), activity (walking / cycling / hiking / standing-and-gazing), solitude count (1 / 2 / 3), complexity (L1 single plane / L2 fore+mid / L3 full multi-plane vista), and weather/time (midday / golden hour / sunset / overcast / mist / blue hour). Trigger when user says /tiny-wanderer, asks for a "tiny wanderer illustration", "bande-dessinée landscape", "Moebius-style travel illustration", "ink-hatched vertical landscape", or briefs with a palette + landscape archetype + complexity in this house style.',
    source: imageStyleSource("tiny-wanderer"),
  },
  {
    id: "image-style:iberian-vignette",
    kind: "image-style",
    name: "Iberian Vignette",
    description:
      "Hand-drawn editorial vignette style — loose wobble ink, flat muted cream + burgundy + one accent (sage / mustard / dusty blue / terracotta), minimal abstract faces, observed Mediterranean composition with a serif Spanish wordmark at the bottom.",
    desc: 'Iberian-vignette hand-drawn editorial illustration: loose hand-drawn ink linework with visible wobble and varied weight, flat muted color fills (no gradients, no shading, no texture) on a warm cream off-white background, burgundy/wine always present as the anchor color somewhere in the scene, exactly one secondary accent per piece (sage green / mustard yellow / dusty muted blue / terracotta-rust), minimal abstract faces (tiny dot or short-mark eyes, soft nose hint, almost no mouth), hair as flat color masses, warm sand skin tones, casually-observed body language (leaning, holding, mid-action, never stiffly posed), and a short Spanish serif lowercase wordmark anchored at the bottom center of the canvas. Always grounded by an architectural / scenic prop (stone arched doorway, tall arched window, balcony, sunlit courtyard, wooden counter, archway, stoop, open terrace). Six dials per brief: scene metaphor (trade shop, domestic moment, leisure ritual), cast (solo L1 / pair L2 / 3-4 figures L3), architectural prop, secondary accent (one only), wordmark (Spanish noun), complexity (L1/L2/L3). Trained on nano-banana-2 image-to-image with one of three locked anchor references (mañana / ritmo / familia). Trigger when user says /iberian-vignette, asks for an "Iberian vignette illustration", a "Spanish editorial illustration", a "Mediterranean observed-moment scene", or briefs a scene metaphor + cast + complexity in this hand-drawn editorial style.',
    source: imageStyleSource("iberian-vignette"),
  },
  {
    id: "image-style:cozy-parlor",
    kind: "image-style",
    name: "Cozy Parlor",
    description:
      "Hand-painted watercolor + ink-line scene — one anthropomorphic animal in a quiet domestic interior, clean cool-white paper, neutral palette with one hot accent pop.",
    desc: "Hand-painted watercolor + brushy black ink line on clean cool-white paper (no amber tint). ONE anthropomorphic animal mid-quiet-activity in a domestic interior. Closed-crescent-eye smile, minimal facial features, expression through posture. At least two patterned surfaces per piece. Cool/neutral palette lead (sage, slate-blue, cornflower, lavender, mint, dove-gray) with a single hot accent pop (cherry-red, mustard, magenta-pink) on one object. Six dials per brief — cast, activity, palette family, pattern motif stack, hot accent object, and complexity (L1/L2/L3). Trigger when user says /cozy-parlor, asks for a 'cozy parlor illustration', a 'watercolor animal scene', a 'picture-book interior', or a new piece in this neutral-palette watercolor style.",
    source: imageStyleSource("cozy-parlor"),
  },
  {
    id: "image-style:crowd-ink",
    kind: "image-style",
    name: "Crowd Ink",
    description:
      "Hand-drawn editorial crowd illustration — sketchy black ink contours over flat 3-color spot fills on pure white, scene-as-metaphor composition.",
    desc: 'Hand-drawn editorial crowd illustration style — confident sketchy black ink contour lines with slightly irregular weight, flat 3-color spot fills sitting under or beside the ink lines (edges allowed to misregister slightly), on a PURE WHITE background (never cream). Fine-line backdrop drawn lighter than the foreground figures, scattered atmospheric marks in negative space (birds / leaves / steam / confetti / dots), and a scene-as-metaphor composition with a cast that varies per piece. Six dials per brief — palette (tested families: urban editorial / cool transit / warm natural / cozy interior), scene metaphor, complexity (L2 small group of 3–5 / L3 full crowd of 8–10), cast, backdrop, atmospheric motif. Trigger when the user says /crowd-ink, asks for a "crowd-ink illustration", "editorial crowd scene", "hand-drawn ink-and-spot-color illustration", "New-Yorker-style crowd vignette", or briefs with palette + scene metaphor + complexity level.',
    source: imageStyleSource("crowd-ink"),
  },
  {
    id: "image-style:ink-storefront",
    kind: "image-style",
    name: "Ink Storefront",
    description:
      "Single-color hand-drawn ink fineliner illustration of a small storefront on warm cream paper — hand-lettered shop sign, foliage, and street props.",
    desc: 'Boutique-poster illustration style — a single-color hand-drawn ink line drawing of a small storefront (café, boulangerie, florist, bookshop, ramen, wine bar, barber, record store, etc.) seen from street level on warm cream paper #f4ecd8. Locked frame: portrait 1024x1536, monochromatic ink with occasional double-stroke shadow under awnings and signs, a hand-lettered shop sign baked into the building, foliage and at least one small street prop (bike, A-frame chalkboard, planters, lanterns, café tables, dog/cat at the door), and a faint horizontal sidewalk line across the bottom. No solid color fills, no shading, no gradients. Seven dials per brief — ink color, shop name + subtitle, archetype, perspective (flat facade vs 3/4 corner), foreground props, foliage density, and complexity (L1 single facade / L2 small scene / L3 full vignette). Trigger when user says /ink-storefront, asks for a "shopfront illustration", "storefront poster", "boutique fineliner illustration", "café line drawing", or briefs with a shop name + ink color + archetype in this house style.',
    source: imageStyleSource("ink-storefront"),
  },
];

// ── Presentation reverse-template guide ─────────────────────────────────────
// This is a pull-only authoring resource. Keep it out of RESOURCE_REGISTRY so
// it does not appear as a presentation-generation skill candidate: it is used
// only when an uploaded deck is being reverse-engineered into a new template.

const PRESENTATION_REVERSE_TEMPLATE_RESOURCE: RegistryEntry = {
  id: PRESENTATION_REVERSE_TEMPLATE_RESOURCE_ID,
  kind: "skill",
  name: "Presentation Reverse Template",
  description:
    "Extract reusable presentation identity guidance and high-fidelity visual assets from an uploaded deck.",
  source: privateR2ArchiveSource(
    PRESENTATION_REVERSE_TEMPLATE_RESOURCE_PATH,
    PRESENTATION_REVERSE_TEMPLATE_ARCHIVE_SHA256,
  ),
  targets: ["presentation"],
};

export function findPresentationReverseTemplateResource(
  resourceId: string,
): RegistryEntry | undefined {
  return resourceId === PRESENTATION_REVERSE_TEMPLATE_RESOURCE_ID
    ? PRESENTATION_REVERSE_TEMPLATE_RESOURCE
    : undefined;
}

// ── Presentation runbook packages ────────────────────────────────────────────
// Self-contained per-template presentation packages (agent runbook + renderer)
// uploaded to private R2 as one archive each. When a selected template ships one
// of these, the agent pulls exactly that archive by template, then selects a
// color system at runtime — no separate design system or color archive to
// resolve. Templates without a package fall back to the legacy multi-resource
// flow. These are intentionally NOT part of RESOURCE_REGISTRY so they never leak
// into the legacy multi-resource candidate slice (selectResourceCandidates) or
// listTemplates.

export interface PresentationRunbookPackage {
  /** Picker template id (the legacy `template:html-ppt-*` id the user selects). */
  readonly templateId: string;
  /** Pull id for the runbook archive; distinct from `templateId`. */
  readonly resourceId: string;
  /** Top-level directory inside the archive; also the runbook command prefix. */
  readonly slug: string;
  /** Default color-system token applied when the user selects no color system. */
  readonly defaultColorSystem: string;
  /** Display name (relocated onto the package so runbook resolution no longer
   * needs the legacy `template:html-ppt-*` registry entry). */
  readonly name: string;
  /** Template description (relocated from the legacy template entry). */
  readonly description: string;
  readonly source: ResourceSourceRef;
}

// Immutable archive digests used to locate each canonical storage and serve
// older digest-pinned CLIs. Current CLIs download the storage HEAD, so these
// intentionally do not track later presentation template publishes.
const PRESENTATION_RUNBOOK_ARCHIVE_SHA256: Record<string, string> = {
  bloom: "732a602bf37d8f10d8be14c63fd7ae12de0591dae41f9661fd29aa8591bc6465",
  "blueprint-academy":
    "3f3cc69eb216990518ee46164ea0a69a370ce5714d566c0e995a98f8acd2a9d8",
  "botane-organic":
    "b4824cc2e220af95203b0041d959d3be53253878e760a2502b79e2d8503319cf",
  "business-data":
    "1f35bf0411a528948e94e8fdccb530aea3f2ee81681277bf720161937c2c47c2",
  crayon: "24547aae70248b373e13b32bfcba39a53bb4d0ddc8b5ded502e9e0f4d967629a",
  "creative-agency":
    "98d4308b77075181a9bc25c97eb5aab63d406f08fbbdc11240b5242c18695ba0",
  "data-report":
    "64c088e596fd4a5d00ff2d001725eab1ff9ccdf12b66360eff968a42adbd1af8",
  "editorial-magazine":
    "e135fe2d90af35ad9cc177718d1758c36e7089fe63ac4b075203c1c06f12ba35",
  "landing-consulting":
    "94781705145e5dff3595dd9e5c08fc0e8985c29737ecf664554a91d6ccc95482",
  lumina: "ee353d4ecefdbe8cda164bd6174baff75a549671c5d0f720b75eca31bf26c3bb",
  meridian: "37072fe02a4e4df34d064f39237f98895b5d6d7514857171aa6cb99cdf57209b",
  "mosaic-geometric":
    "8b6698813045d4cf52e26d5cd73ca6574529e58e1f2cc22a6db9de7b3b6a3a18",
  "neo-brutalism":
    "ebb3a334c12473527009ea73d2c6b2097d38b3502bd6d12e610ceab9ae0ca252",
  nocturne: "f78892def8d6a214ec3eadb384fce8da13dfec686319d9383798f536b8187fbb",
  "pixel-glitch":
    "242b7f6df74dfc3799de68a11e721d6def4552b05009a9578e1cb88622c371e5",
  "playful-launch":
    "e7ce6bda402a444b83ada485c71c3e0538b3692b4803cd7f96054ca07e81180a",
  "playful-pop":
    "d3de99c9b8e931de2343d511dda04f57d1deaa29c945ef4c91a5382e948c9263",
  prospectus:
    "7ec19e6ce032544d1e4653bed9485fce0a5551bea6197c450e0b60bc28d7d16f",
  schoolhouse:
    "387b2fb59ecac95dbe3b4e6f27d7e6ebda3ce4be317227f6506f87d02e264fc0",
  "sticker-scrapbook":
    "a00b744d85d2e668cb98945e9758bc6222ea4f3c3b62e72842f1568d35501f3f",
  strata: "c1396282cf80446b4cb97f8fa6859b5bd95c50090f8dcf1278a817e6e0b64cfb",
  "taped-consulting":
    "c4ccffadd45dac50b9b8dc3bf0fd6f2ffa91e1cc6691ba63b5a7a1784e16d7ca",
  vantage: "888b1478b295e1e6b0e7ae5b579261206fce4edf48c6f42893194471cdeb2c78",
};

function presentationRunbookArchiveSha256(slug: string): string {
  const sha256 = PRESENTATION_RUNBOOK_ARCHIVE_SHA256[slug];
  if (!sha256) {
    throw new Error(`Missing presentation runbook archive sha256 for ${slug}`);
  }
  return sha256;
}

// Each entry maps a picker template id to its runbook package slug (the
// presentation-final directory name) and the renderer's default color token.
const PRESENTATION_RUNBOOK_PACKAGE_DEFS: readonly {
  readonly templateId: string;
  readonly slug: string;
  readonly defaultColorSystem: string;
  readonly name: string;
  readonly description: string;
}[] = [
  {
    templateId: "template:html-ppt-playful-launch",
    slug: "playful-launch",
    defaultColorSystem: "carnival",
    name: "Playful Launch Presentation",
    description:
      "15-slot HTML presentation structure for product and service launches with oversized headlines, color-field rhythm, recurring motifs, and required media slots.",
  },
  {
    templateId: "template:html-ppt-bloom-pitch",
    slug: "bloom",
    defaultColorSystem: "carnival",
    name: "Bloom Pitch Presentation",
    description:
      "15-slot playful investor-pitch presentation structure with oversized headlines, colour-field dividers, organic visuals, stat stacks, quote cards, and pricing cards.",
  },
  {
    templateId: "template:html-ppt-blueprint-academy",
    slug: "blueprint-academy",
    defaultColorSystem: "forest_editorial",
    name: "Blueprint Academy Presentation",
    description:
      "15-slot academic education presentation structure with blueprint grids, wire diagrams, matted photos, goal cards, process spines, stats, testimonials, and contact slides.",
  },
  {
    templateId: "template:html-ppt-botane-organic",
    slug: "botane-organic",
    defaultColorSystem: "mauve_dusk",
    name: "Botane Organic Presentation",
    description:
      "15-slot organic wellness deck with colour-block panels, circular media, side titles, icon cycles, and donut stats.",
  },
  {
    templateId: "template:html-ppt-business-data",
    slug: "business-data",
    defaultColorSystem: "berry_pop",
    name: "Business Data Presentation",
    description:
      "15-slot HTML presentation structure for metric-led business reports with big numbers, stat strips, bars, rings, photo squares, and dark/accent proof slides.",
  },
  {
    templateId: "template:html-ppt-crayon",
    slug: "crayon",
    defaultColorSystem: "prism",
    name: "Crayon Presentation",
    description:
      "Light 15-slot playful education deck with peripheral blobs, multi-colour marker titles, doodle sparks, colour-block cards, burst stats, quote cards, and rounded pricing cards.",
  },
  {
    templateId: "template:html-ppt-creative-agency",
    slug: "creative-agency",
    defaultColorSystem: "coral_studio",
    name: "Creative Agency Presentation",
    description:
      "Minimal modern 15-slot agency deck with generous whitespace, foliage sprigs, B&W photo blocks, sharp rectangles, team grids, icon services, process spine, and a big-stat impact band.",
  },
  {
    templateId: "template:html-ppt-data-report",
    slug: "data-report",
    defaultColorSystem: "prism",
    name: "Data Report Presentation",
    description:
      "Chart-led 15-page data report variant with saturated colour grounds, sharp outlines, frameless numbers, stacked/combo/area/line/doughnut/pie/bar/bubble charts, and data-first summary pages.",
  },
  {
    templateId: "template:html-ppt-editorial-magazine",
    slug: "editorial-magazine",
    defaultColorSystem: "warm_sand",
    name: "Editorial Magazine Presentation",
    description:
      "Restrained 15-slot magazine deck with masthead cover, dotted TOC, colour-block dividers, two-column editorial pages, roman/italic titles, running footer, stat boxes, quote rows, and editorial table.",
  },
  {
    templateId: "template:html-ppt-landing-consulting",
    slug: "landing-consulting",
    defaultColorSystem: "pop_art",
    name: "Landing Consulting Presentation",
    description:
      "Consulting deck dressed like a landing page, with persistent nav chrome, two-tone display titles, dashed circuit wires, marker emphasis, speech-bubble callouts, square photo blocks, frameless stats, and CTA rhythm.",
  },
  {
    templateId: "template:html-ppt-lumina",
    slug: "lumina",
    defaultColorSystem: "prism",
    name: "Lumina Presentation",
    description:
      "Sticker-tag creative studio deck with brush-letter title accents, asterisk punctuation, frame-edge chrome, sharp colour cells, photo blocks, stat bands, and agency-style 15-slot rhythm.",
  },
  {
    templateId: "template:html-ppt-meridian",
    slug: "meridian",
    defaultColorSystem: "slate_corporate",
    name: "Meridian Presentation",
    description:
      "15-slot professional data-agency presentation structure with flat nav chrome, sharp blocks, index numbers, stat matrices, bar charts, service blocks, and executive close.",
  },
  {
    templateId: "template:html-ppt-mosaic-geometric",
    slug: "mosaic-geometric",
    defaultColorSystem: "carnival",
    name: "Mosaic Geometric Presentation",
    description:
      "Bold modular geometric 15-slot pitch deck with Bauhaus mosaic tile clusters, dotted TOC, chapter dividers, framed icon services, process spine, gallery grid, segmented pie, burst stats, quote rows, and price cards.",
  },
  {
    templateId: "template:html-ppt-neo-brutalism",
    slug: "neo-brutalism",
    defaultColorSystem: "mono_ink",
    name: "Neo Brutalism Presentation",
    description:
      "Bold 15-slot brutalist business-plan deck with persistent nav chrome, CTA pairs, numbered circles, arch cards, and heavy framed content blocks.",
  },
  {
    templateId: "template:html-ppt-nocturne",
    slug: "nocturne",
    defaultColorSystem: "midnight_mono",
    name: "Nocturne Presentation",
    description:
      "Dark 15-slot data-keynote deck with rounded chart devices, frameless hero numbers, bento metrics, and clear text/data alternation.",
  },
  {
    templateId: "template:html-ppt-pixel-glitch",
    slug: "pixel-glitch",
    defaultColorSystem: "bauhaus_primary",
    name: "Pixel Glitch Presentation",
    description:
      "15-slot Y2K creative-studio presentation structure with pixel trails, glitch titles, sharp dividers, image blocks, ring charts, process spines, and bold proof pages.",
  },
  {
    templateId: "template:html-ppt-playful-pop",
    slug: "playful-pop",
    defaultColorSystem: "pop_art",
    name: "Playful Pop Presentation",
    description:
      "Loud 15-slot playful brand deck with neon-on-dark Pop Art colour, overlapping offset-shadow cards, organic blobs, corner dot grids, burst rosettes, pill chips, icon quads, process spine, photo gallery, quotes, and pricing.",
  },
  {
    templateId: "template:html-ppt-prospectus",
    slug: "prospectus",
    defaultColorSystem: "slate_corporate",
    name: "Prospectus Presentation",
    description:
      "15-slot corporate landing-page business-plan structure with persistent nav, colour-field stages, diagonal arrows, CTA clusters, flat charts, gantt timelines, and pricing tiers.",
  },
  {
    templateId: "template:html-ppt-schoolhouse",
    slug: "schoolhouse",
    defaultColorSystem: "bauhaus_primary",
    name: "Schoolhouse Presentation",
    description:
      "15-slot retro school-poster presentation structure with paper stages, stamp badges, index cards, ruled rows, stat bands, quote cards, and membership tiers.",
  },
  {
    templateId: "template:html-ppt-sticker-scrapbook",
    slug: "sticker-scrapbook",
    defaultColorSystem: "prism",
    name: "Sticker Scrapbook Presentation",
    description:
      "15-slot vibrant scrapbook presentation structure with sticker seals, spiral pads, agenda cards, doodle dividers, photo grids, stat stickers, quote cards, and pricing cards.",
  },
  {
    templateId: "template:html-ppt-strata",
    slug: "strata",
    defaultColorSystem: "mono_ink",
    name: "Strata Presentation",
    description:
      "15-slot Swiss-minimal agency presentation structure with giant caps, asterisk dividers, tile ramps, mono photo grids, frameless stats, quote cards, and pricing cards.",
  },
  {
    templateId: "template:html-ppt-taped-consulting",
    slug: "taped-consulting",
    defaultColorSystem: "slate_corporate",
    name: "Taped Consulting Presentation",
    description:
      "15-slot consulting presentation structure with taped photo clusters, inset frames, feature rows, process spines, big-number proof, quote cards, and pricing cards.",
  },
  {
    templateId: "template:html-ppt-vantage",
    slug: "vantage",
    defaultColorSystem: "slate_corporate",
    name: "Vantage Presentation",
    description:
      "15-slot business-proposal presentation structure with two-tone headings, corner indexes, square-pair motifs, split panels, frameless numbers, donut charts, and milestone lines.",
  },
];

function presentationRunbookPackages(): readonly PresentationRunbookPackage[] {
  return PRESENTATION_RUNBOOK_PACKAGE_DEFS.map((def) => {
    return {
      templateId: def.templateId,
      resourceId: `${def.templateId}-runbook`,
      slug: def.slug,
      defaultColorSystem: def.defaultColorSystem,
      name: def.name,
      description: def.description,
      source: privateR2ArchiveSource(
        def.slug,
        presentationRunbookArchiveSha256(def.slug),
      ),
    };
  });
}

const PRESENTATION_RUNBOOK_PACKAGES: readonly PresentationRunbookPackage[] =
  presentationRunbookPackages();

export function listPresentationRunbookPackages(): readonly PresentationRunbookPackage[] {
  return PRESENTATION_RUNBOOK_PACKAGES;
}

/** Resolve the runbook package for a picker template id, if one exists. */
export function findPresentationRunbookPackage(
  templateId: string,
): PresentationRunbookPackage | undefined {
  return PRESENTATION_RUNBOOK_PACKAGES.find((pkg) => {
    return pkg.templateId === templateId;
  });
}

/**
 * Resolve a runbook package archive by its pull resource id, shaped as a
 * RegistryEntry so the download route and `okou resource pull` can treat it like
 * any other private archive.
 */
export function findPresentationRunbookResource(
  resourceId: string,
): RegistryEntry | undefined {
  const pkg = PRESENTATION_RUNBOOK_PACKAGES.find((entry) => {
    return entry.resourceId === resourceId;
  });
  if (!pkg) {
    return undefined;
  }
  // Name/description live on the package itself (relocated from the legacy
  // `template:html-ppt-*` registry entry) so this no longer depends on that
  // entry surviving. Only id and source diverge.
  return {
    id: pkg.resourceId,
    kind: "template",
    name: pkg.name,
    description: pkg.description,
    source: pkg.source,
    targets: ["presentation"],
  };
}

// ── Website template packages ────────────────────────────────────────────────
// Self-contained website packages uploaded to private R2. Keep these pull-only
// resources out of RESOURCE_REGISTRY so the feature-switched picker remains the
// only user-facing catalog for built-in website templates.

export interface WebsiteTemplatePackage {
  /** Picker template id; this is also the pull id for website packages. */
  readonly templateId: WebsiteTemplateItem["templateId"];
  readonly resourceId: WebsiteTemplateItem["resourceId"];
  readonly slug: WebsiteTemplateItem["slug"];
  readonly name: WebsiteTemplateItem["title"];
  readonly description: WebsiteTemplateItem["description"];
  readonly source: ResourceSourceRef & {
    readonly archive: NonNullable<ResourceSourceRef["archive"]>;
  };
}

// Archive digests for uploaded private R2 website template packages. Keep these
// in sync with the private R2 version ids served by the API download route.
const WEBSITE_TEMPLATE_ARCHIVE_SHA256: Record<string, string> = {
  "black-slabs":
    "a2ba4a18fe6be58a05a99fcf755f696629c7cbfe295ec9e4f7685bef1eebff79",
  "blueprint-grid":
    "b0312334dd8ad42f2e8b219cc0522bd11b0de1d246d133b34d9b832352286468",
  "coastal-hotel":
    "4df5f2099cee35c286af6af9e3413f496a6b45b9423d7308336ad8372468efa3",
  "dot-matrix":
    "5d9f69b7f9625681b5b6183623cbece78c4f40dc6fe585ca799212d05e589623",
  "frame-stack":
    "b00cbbe2a39486545d695986b6d2be2def28916d4d21fc80591c64d326ddaa5a",
  "frosted-scatter":
    "3aa13240db1b905b8222c3eb7eccacfeec44f93aba30e3f495e0e2f1dc395e58",
  "gallery-wall":
    "41941dd3c92814efc30a36ec8c4929aecda48335619c8684c2e0d3c3d0cbd1fa",
  "glass-bloom":
    "455acd8f36c55a30b3a58654f3f2d5d20b58fcef379b99a28c52aac54246eaf6",
  "serif-stack":
    "f6eb7b64155f25e9361fbe4f6ea3eb5e7ed626445472e38d15af52b99204036a",
  "sticker-pop":
    "3f7fb7f11dcf6524eec1aa2f94fb3df145ae78fc21b7797c23fdfd2ec5ec481a",
  "warm-cards":
    "52f5f9670b3d0fba697635d35784bc021a2150f1c84cc73af87c6fd049ed8234",
};

function websiteTemplateArchiveSha256(slug: string): string {
  const sha256 = WEBSITE_TEMPLATE_ARCHIVE_SHA256[slug];
  if (!sha256) {
    throw new Error(`Missing website template archive sha256 for ${slug}`);
  }
  return sha256;
}

const WEBSITE_TEMPLATE_PACKAGES: readonly WebsiteTemplatePackage[] =
  WEBSITE_TEMPLATE_ITEMS.map((item) => {
    return {
      templateId: item.templateId,
      resourceId: item.resourceId,
      slug: item.sourcePath,
      name: item.title,
      description: item.description,
      source: privateR2ArchiveSource(
        item.sourcePath,
        websiteTemplateArchiveSha256(item.slug),
      ),
    };
  });

const WEBSITE_TEMPLATE_V2_ARCHIVE_SHA256: Record<string, string> = {
  "black-slabs":
    "de6f78c5a524cf3959ca56af7a93ec5bca113555bbd1a5983eebf1bc353971d4",
  "blueprint-grid":
    "dec02c4fe156566272a92b7386cb032cec7e3a1250dd42429ca3e7f42374dc28",
  "coastal-hotel":
    "09d239d7a0e1c27334f2c3c8da9e408174cece6bcc8a34342438598db739aa4e",
  "dot-matrix":
    "0beb9b1bcb12ace6d3541df269a629af8e3b41c8f9d7e3c3fcfe069655cd9074",
  "frame-stack":
    "7c4c13eaa22b4185607c6ac6a726dd931fe896b279b38a6267c0105f81214f8b",
  "frosted-scatter":
    "c67a7baf924ae4b57241e61527dd875d084e38040653a9bbcc659c13d2382cf9",
  "gallery-wall":
    "f6e41fb711b8c9317a425b463a9812e99f2aecb630d1acbfb77ef0965c2ba55f",
  "glass-bloom":
    "713fbac57cf37a0ddd6d7e7d79a0b9f29f8fff7a0aa55bc741bc5dcd0e498d25",
  "serif-stack":
    "6d5d65fb21d6c5ec5627fe32fbfc55e80841a2343f2d91bf3ee3a0f62547766a",
  "sticker-pop":
    "61954f4652e2cc86cd1016a537078ea050fe95735a7477e6bd56c91a0c0aec3b",
  "warm-cards":
    "213197ef200b16738b51b5d6c4a90b6e6c12c86c63207ef6afc31456cdd0d2e1",
};

function websiteTemplateV2ArchiveSha256(slug: string): string {
  const sha256 = WEBSITE_TEMPLATE_V2_ARCHIVE_SHA256[slug];
  if (!sha256) {
    throw new Error(`Missing website template v2 archive sha256 for ${slug}`);
  }
  return sha256;
}

// Keep refreshed packages outside the picker-backed list. Website generation
// resolves to these additive v2 resource ids, while released clients continue
// pulling the original package ids.
const WEBSITE_TEMPLATE_V2_PACKAGES: readonly WebsiteTemplatePackage[] =
  WEBSITE_TEMPLATE_ITEMS.map((item) => {
    return {
      templateId: `${item.templateId}-v2`,
      resourceId: `${item.resourceId}-v2`,
      slug: item.sourcePath,
      name: item.title,
      description: item.description,
      source: privateR2ArchiveSource(
        item.sourcePath,
        websiteTemplateV2ArchiveSha256(item.slug),
      ),
    };
  });

function websiteTemplatePackageToRegistryEntry(
  pkg: WebsiteTemplatePackage,
): RegistryEntry {
  return {
    id: pkg.resourceId,
    kind: "template",
    name: pkg.name,
    description: pkg.description,
    source: pkg.source,
    targets: ["website"],
  };
}

export function listWebsiteTemplatePackages(): readonly WebsiteTemplatePackage[] {
  return WEBSITE_TEMPLATE_PACKAGES;
}

export function findWebsiteTemplatePackage(
  templateId: string,
): WebsiteTemplatePackage | undefined {
  const v2Package = WEBSITE_TEMPLATE_V2_PACKAGES.find((pkg) => {
    return pkg.templateId === templateId || pkg.resourceId === templateId;
  });
  if (v2Package) {
    return v2Package;
  }
  const directPackage = WEBSITE_TEMPLATE_PACKAGES.find((pkg) => {
    return pkg.templateId === templateId || pkg.resourceId === templateId;
  });
  if (directPackage) {
    return directPackage;
  }
  const normalizedTemplateId =
    findWebsiteTemplateItem(templateId)?.templateId ?? templateId;
  return WEBSITE_TEMPLATE_PACKAGES.find((pkg) => {
    return pkg.templateId === normalizedTemplateId;
  });
}

export function findWebsiteTemplateResource(
  resourceId: string,
): RegistryEntry | undefined {
  const directPackage = WEBSITE_TEMPLATE_V2_PACKAGES.find((pkg) => {
    return pkg.resourceId === resourceId;
  });
  if (directPackage) {
    return websiteTemplatePackageToRegistryEntry(directPackage);
  }
  const normalizedResourceId =
    findWebsiteTemplateItem(resourceId)?.resourceId ?? resourceId;
  const pkg = WEBSITE_TEMPLATE_PACKAGES.find((entry) => {
    return entry.resourceId === normalizedResourceId;
  });
  if (!pkg) {
    return undefined;
  }
  return websiteTemplatePackageToRegistryEntry(pkg);
}

const COLOR_SYSTEM_ID_PREFIX = "color-system:";

/**
 * Map a registry color-system id (`color-system:warm-sand`) to the snake_case
 * token the presentation runbook expects (`warm_sand`). Returns undefined when the
 * id is not a known color system.
 */
export function presentationColorSystemToken(
  colorSystemId: string,
): string | undefined {
  if (!findColorSystem(colorSystemId)) {
    return undefined;
  }
  return colorSystemId
    .slice(COLOR_SYSTEM_ID_PREFIX.length)
    .replaceAll("-", "_");
}

/**
 * Resolve the color-system token for a presentation runbook: an explicit color
 * system id must resolve to a known token; with none, the package's default
 * token is used. Returns `{ token }` or `{ error }`.
 */
export function resolvePresentationRunbookColorToken(
  runbookPackage: PresentationRunbookPackage,
  colorSystemId: string | undefined,
): { readonly token: string } | { readonly error: "unknown-color-system" } {
  if (!colorSystemId) {
    return { token: runbookPackage.defaultColorSystem };
  }
  const token = presentationColorSystemToken(colorSystemId);
  if (!token) {
    return { error: "unknown-color-system" };
  }
  return { token };
}

/**
 * Shared runbook authoring instructions for a selected presentation template.
 * Used by both the chat generation-template prompt (API) and
 * `okou generate presentation --template` (CLI) so the two never drift.
 */
export function buildPresentationRunbookInstructionLines(args: {
  readonly runbookPackage: PresentationRunbookPackage;
  readonly colorSystemToken: string;
  readonly hostCommand?: string;
}): readonly string[] {
  const { runbookPackage: pkg, colorSystemToken } = args;
  const packageDir = `./generated/resources/${pkg.slug}`;
  const hostCommand =
    args.hostCommand ??
    "okou host <output-dir> --site <slug> --artifact-kind presentation-html";
  return [
    `Selected presentation template: ${pkg.name} (${pkg.templateId})`,
    `Color system token: ${colorSystemToken}`,
    "",
    "To produce the presentation:",
    `- Pull the package: okou resource pull ${pkg.resourceId} --dir ./generated/resources`,
    `- Read ${packageDir}/SKILL.md fully and follow its template, authoring, and verification instructions.`,
    PRESENTATION_IMAGE_BATCH_INSTRUCTION,
    "- Use the requested slide count; default to 8.",
    PRESENTATION_STATIC_HTML_INSTRUCTION,
    `- Host the finished deck: ${hostCommand}`,
    "- Return only the HTML deck.",
  ];
}

function filterByKind(kind: ResourceKind): readonly RegistryEntry[] {
  return RESOURCE_REGISTRY.filter((entry) => {
    return entry.kind === kind;
  });
}

export function listImageStyles(): readonly RegistryEntry[] {
  return filterByKind("image-style");
}

export function listSkills(
  target?: GenerationTarget,
): readonly RegistryEntry[] {
  const all = filterByKind("skill");
  if (target === undefined) {
    return all;
  }
  return all.filter((entry) => {
    return entry.targets?.includes(target) ?? false;
  });
}

export function findSkill(id: string): RegistryEntry | undefined {
  return listSkills().find((entry) => {
    return entry.id === id;
  });
}

export function listTools(): readonly RegistryEntry[] {
  return filterByKind("tool");
}

export function findTool(id: string): RegistryEntry | undefined {
  return listTools().find((entry) => {
    return entry.id === id;
  });
}

export function findImageStyle(id: string): RegistryEntry | undefined {
  return listImageStyles().find((entry) => {
    return entry.id === id;
  });
}

const VIDEO_TEMPLATE_ID_ALIASES: Readonly<Record<string, string>> = {
  "athletic-motivation": "video-template:sports-performance-ad",
  "video-template:athletic-motivation": "video-template:sports-performance-ad",
  "imax-epic-cinematic": "video-template:epic-grandeur",
  "video-template:imax-epic-cinematic": "video-template:epic-grandeur",
  "luxury-watch-product": "video-template:luxury-product",
  "video-template:luxury-watch-product": "video-template:luxury-product",
};

export function canonicalizeVideoTemplateId(id: string): string {
  const alias = VIDEO_TEMPLATE_ID_ALIASES[id];
  if (alias) {
    return alias;
  }
  if (id.startsWith("video-template:")) {
    return id;
  }
  return `video-template:${id}`;
}

export function listVideoTemplates(): readonly VideoTemplateRegistryEntry[] {
  return VIDEO_TEMPLATE_REGISTRY;
}

export function findVideoTemplate(
  id: string,
): VideoTemplateRegistryEntry | undefined {
  const canonicalId = canonicalizeVideoTemplateId(id);
  return listVideoTemplates().find((entry) => {
    return entry.id === canonicalId;
  });
}

export function listDesignSystems(): readonly RegistryEntry[] {
  return filterByKind("design-system");
}

export function findDesignSystem(id: string): RegistryEntry | undefined {
  return listDesignSystems().find((entry) => {
    return entry.id === id;
  });
}

export function listColorSystems(): readonly RegistryEntry[] {
  return filterByKind("color-system");
}

export function findColorSystem(id: string): RegistryEntry | undefined {
  return listColorSystems().find((entry) => {
    return entry.id === id;
  });
}

export function listTemplates(
  target?: GenerationTarget,
): readonly RegistryEntry[] {
  const all = filterByKind("template");
  if (target === undefined) {
    return all;
  }
  const filtered = all.filter((entry) => {
    return entry.targets?.includes(target) ?? false;
  });
  if (target !== "website") {
    return filtered;
  }
  const websitePackageEntries = WEBSITE_TEMPLATE_PACKAGES.map(
    websiteTemplatePackageToRegistryEntry,
  ).filter((entry) => {
    return !filtered.some((template) => {
      return template.id === entry.id;
    });
  });
  return [...filtered, ...websitePackageEntries];
}

export function findTemplate(id: string): RegistryEntry | undefined {
  return filterByKind("template").find((entry) => {
    return entry.id === id;
  });
}

export function selectResourceCandidates(
  target?: GenerationTarget,
): ResourceCandidateSlice {
  return {
    registryVersion: RESOURCE_REGISTRY_VERSION,
    source: {
      repo: RESOURCE_REGISTRY_REPO,
      ref: RESOURCE_REGISTRY_COMMIT,
    },
    candidates: {
      skills: listSkills(target),
      templates: listTemplates(target),
      designSystems: filterByKind("design-system"),
    },
  };
}
