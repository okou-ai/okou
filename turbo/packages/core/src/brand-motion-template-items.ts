/**
 * Display and selection metadata for the approved Video Motion Templates v1
 * catalog (36 entries). Source IDs are preserved from its 2026-09-14 manifest:
 * https://dpl-5d78196b-dec7-4fd3-8699-bc60c1e21c29.okou.app/templates/manifest.json
 *
 * Composition code, supported brand inputs and rendering defaults belong to
 * vm0-ai/vm0-skills/brand-motion. Resource paths intentionally remain null until
 * that skill is published and verified (vm0-ai/vm0#34050). The research gallery
 * is provenance only; runtime execution must never load its mutable sources.
 */
export const BRAND_MOTION_SKILL_NAME = "brand-motion";

export interface BrandMotionTemplateItem {
  readonly id: `brand-motion:${string}`;
  readonly slug: string;
  readonly sourceTemplateId: string;
  readonly title: string;
  readonly description: string;
  readonly previewImage: string | null;
  readonly previewVideo: string | null;
  /** Composition path relative to the canonical brand-motion skill root. */
  readonly sourcePath: string | null;
}

export const BRAND_MOTION_TEMPLATE_ITEMS: readonly BrandMotionTemplateItem[] = [
  {
    sourceTemplateId: "brand-mask-sweep-lockup",
    title: "Precision",
    description: "A precise mask sweep reveals the logo and wordmark.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "brand-stroke-draw-lockup",
    title: "Contour",
    description:
      "Fine strokes draw the mark before filling it and revealing the wordmark.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "brand-particle-logo-reveal",
    title: "Assembly",
    description: "Small particles converge into the complete brand lockup.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "brand-parts-assemble-lockup",
    title: "Structure",
    description: "Separate strokes assemble into the logo and wordmark.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "brand-impact-logo-sting",
    title: "Impulse",
    description: "A short impact settles the logo with a subtle pulse.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "brand-letter-cascade-close",
    title: "Cascade",
    description: "Letters arrive in sequence and settle on a shared baseline.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "brand-calm-brand-lockup",
    title: "Quiet",
    description: "A gentle fade and scale reveal the complete brand lockup.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "brand-ink-bleed-lockup",
    title: "Ink",
    description: "Ink gathers around the mark before the wordmark resolves.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "brand-slit-scan-lockup",
    title: "Scan",
    description: "Offset horizontal slices align into a clear brand lockup.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "brand-facet-morph-lockup",
    title: "Facets",
    description:
      "Light and dark facets fold together into the logo and wordmark.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "brand-wordmark-tiles-lockup",
    title: "Tiles",
    description: "Ordered tiles weave the brand into a complete image.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "brand-astri-particle-lockup",
    title: "Depth",
    description:
      "Particles travel from depth and assemble the brand in the foreground.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-mask",
    title: "Mask Reveal",
    description: "A moving edge reveals the brand from behind a mask.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-iris",
    title: "Iris Open",
    description: "An expanding aperture opens to reveal the complete brand.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-stroke",
    title: "Draw On",
    description:
      "Strokes draw the mark before filling it and revealing the wordmark.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-negative",
    title: "Negative Space",
    description:
      "Expanding color fields expose the brand through negative space.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-particles",
    title: "Particle Assembly",
    description:
      "Scattered particles follow arcs into the precise brand silhouette.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-dissolve",
    title: "Dissolve Resolve",
    description:
      "Fine patches gather as the brand gradually emerges from a haze.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-shards",
    title: "Fragment Assembly",
    description:
      "Fragments arrive from different directions and lock into place.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-tiles",
    title: "Tile Build",
    description: "Small tiles build the brand with an ordered diagonal rhythm.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-monogram",
    title: "Mark To Wordmark",
    description: "The mark appears first, followed by the unfolding wordmark.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-letters",
    title: "Kinetic Lockup",
    description: "Tilted letters enter and align on a shared baseline.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-spring",
    title: "Elastic Landing",
    description:
      "The compressed brand expands and settles with a single rebound.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-ribbon",
    title: "Ribbon Unfurl",
    description: "Staggered ribbons unfold to form the complete wordmark.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-liquid",
    title: "Liquid Reveal",
    description: "A soft wave rises through the brand to reveal its color.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-light",
    title: "Light Sweep",
    description:
      "A narrow light sweeps across the silhouette and restores brand colors.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-glass",
    title: "Refractive Scan",
    description:
      "A refractive glass band passes across the brand to bring it into focus.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-focus",
    title: "Focus Pull",
    description:
      "A blurred, enlarged silhouette sharpens and settles at its final size.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-depth",
    title: "Depth Turn",
    description:
      "The brand turns from a side view and settles facing the viewer.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-orbit",
    title: "Orbit To Lockup",
    description:
      "Fragments orbit the center before returning to their brand positions.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-portal",
    title: "Portal Reveal",
    description:
      "The view pulls back through an enlarged mark into the complete lockup.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-fold",
    title: "Fold Open",
    description:
      "Vertical panels fold open in sequence to reveal the wordmark.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-flash",
    title: "Single Flash",
    description: "A single brief flash brings the brand into place.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-glitch",
    title: "Glitch Resolve",
    description:
      "Offset slices and separated colors resolve into a clear brand lockup.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-scan",
    title: "Scan Build",
    description:
      "A descending scan line turns scattered lines into the solid brand.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
  {
    sourceTemplateId: "reveal-echo",
    title: "Echo Align",
    description: "Offset brand echoes converge into one clear lockup.",
    previewImage: null,
    previewVideo: null,
    sourcePath: null,
  },
].map((template) => {
  return {
    ...template,
    id: `brand-motion:${template.sourceTemplateId}`,
    slug: template.sourceTemplateId,
  };
});

/** Recognize the namespace, including unknown IDs so they never fall through. */
export function isBrandMotionTemplateId(id: string): boolean {
  return id.startsWith("brand-motion:");
}

export function findBrandMotionTemplateItem(
  id: string,
): BrandMotionTemplateItem | undefined {
  return BRAND_MOTION_TEMPLATE_ITEMS.find((template) => {
    return template.id === id;
  });
}

/** Preview availability is independent of whether the composition can execute. */
export function isBrandMotionTemplateReady(
  template: BrandMotionTemplateItem,
): template is BrandMotionTemplateItem & { readonly sourcePath: string } {
  return template.sourcePath !== null && template.sourcePath.trim().length > 0;
}

export function resolveBrandMotionTemplate(
  id: string,
  enabled: boolean,
):
  | {
      readonly status: "resolved";
      readonly template: BrandMotionTemplateItem & {
        readonly sourcePath: string;
      };
    }
  | { readonly status: "invalid"; readonly message: string } {
  if (!enabled) {
    return { status: "invalid", message: "Brand motion is not available" };
  }
  const template = findBrandMotionTemplateItem(id);
  if (!template) {
    return { status: "invalid", message: "Unknown brand motion template" };
  }
  if (!isBrandMotionTemplateReady(template)) {
    return {
      status: "invalid",
      message: "Brand motion template resources are not available yet",
    };
  }
  return { status: "resolved", template };
}

/** A queued or steered selection can become unavailable after admission. */
export function brandMotionUnavailableInstructionLines(
  message: string,
): readonly string[] {
  return [
    "# Unavailable Brand Motion Template",
    "",
    `The current message's selected Brand motion cannot be used: ${message}.`,
    "Explain this unavailability to the user. Do not fulfill this Brand motion request with another motion or generic video generation. Answer unrelated questions normally.",
  ];
}

export function brandMotionInstructionLines(
  template: BrandMotionTemplateItem & { readonly sourcePath: string },
): readonly string[] {
  return [
    `Use the $${BRAND_MOTION_SKILL_NAME} skill to render the selected brand motion from the user's request and attached brand material.`,
    "Read the mounted skill's SKILL.md and manifest before rendering. The canonical source is vm0-ai/vm0-skills/brand-motion, delivered through the existing skills loader.",
    `- Template: ${template.title} (${template.id})`,
    `- Source template ID: ${template.sourceTemplateId}`,
    `- Composition path within the skill: ${template.sourcePath}`,
    "- Resolve this exact source ID and its declared inputs in the skill manifest; use the selected composition and rendering entry point.",
    "- Obtain the required logo, icon or wordmark from the user's attachments and chat context. Ask in chat when a required brand asset is missing; the sample Astri artwork is not the user's brand.",
    "- Preserve supplied artwork and proportions. Follow the skill's supported substitutions; do not assume every composition supports arbitrary geometry or reverse playback.",
    "- Preserve the selected composition's timing, including the default 0.25-second end hold, unless the user requests a supported change.",
    "- If the mounted skill, selected source or required rendering support is unavailable, report that the selected motion cannot run. Do not substitute a generic video generation prompt, another motion, or the research gallery.",
    "- Follow the skill's rendering and verification steps and return one playable MP4 through the existing video artifact delivery flow.",
  ];
}
