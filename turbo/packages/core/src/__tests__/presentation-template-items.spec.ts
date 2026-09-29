import { describe, expect, it } from "vitest";
import {
  PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_THEMES,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
} from "../presentation-template-items";
import {
  findColorSystem,
  findPresentationRunbookPackage,
  listTemplates,
} from "../resource-registry";

const FORBIDDEN_ASSET_URL_PARTS = [
  "drive.google.com",
  "googleusercontent.com",
  "raw.githubusercontent.com",
  "file://",
] as const;

const BOTANE_BORDERLESS_PREVIEW_IMAGES = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/64d1a85a-9347-48fb-860b-073180385b66/botane-organic-deck.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a43f103f-e4b3-40b0-a326-c37a2240e6b5/slide-02.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/576f05a7-2d2c-4963-876b-6eda1fe8f93e/slide-03.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/12a44151-de3a-465d-9631-df029387a922/slide-04.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/cc6d6522-6f49-4dd0-a122-903a2251f014/slide-05.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/2195f286-6e9e-4171-9240-90c03924b898/slide-06.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/889dd3cf-913c-4f79-99fc-c57f4346cef5/slide-07.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/b1116116-80a5-4d4c-bd74-43a66bed970b/slide-08.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/3d0f5b82-cb4d-4b5a-8c7b-de8941758cf8/slide-09.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/7a5835b1-9545-46e1-ac8b-4d33de6fca14/slide-10.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/72162ad3-7cda-4eb8-9bc3-9a986c06e120/slide-11.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/68e2256e-3872-45b5-bcc6-a7cedf6d3e8f/slide-12.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/2a7fd3d2-562f-4b49-8854-562b13fa7fbc/slide-13.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/ba0a9ade-6eba-4a63-8772-976b30ab17cf/slide-14.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/7da6a51c-4a78-4e50-9cbc-899879e72875/slide-15.png",
] as const;

const BUSINESS_DATA_BORDERLESS_PREVIEW_IMAGES = [
  "https://static.vm0.io/vm0/artifact-templates/presentation/9aa42296-a49e-4128-a80a-e920637b1506/business-data-presentation.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/04a3765b-ef6a-4bbb-8ae4-b116941760cf/slide-02.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/1919e6e0-2adf-4727-825d-3470568733e7/slide-03.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/62d71bc2-9359-4a41-bde6-da6e4d9d0fd0/slide-04.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/9d587627-8f20-4aed-ad2b-0593f58c22d9/slide-05.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/b16f1790-05be-4a49-85cd-3417c51376c9/slide-06.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/de3b1bca-c6bf-4f45-ba6e-898ebb51c8ca/slide-07.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/f1fdaf81-3914-4882-89c1-eb2da901dfd8/slide-08.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/982833de-dd95-4560-81b5-8b006d7fe3c7/slide-09.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/15fbcdfa-fc5c-48a8-aa4b-4ea88550b1e2/slide-10.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/4a29b39a-97d0-4c26-892a-85e808f0a21f/slide-11.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/056c9f76-3ee0-4990-a445-72044cc84a66/slide-12.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/a1a1fc29-4682-484e-b5eb-2e09c5b0c8d3/slide-13.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/7817bac4-9ecd-4e00-a532-d6ba2816c322/slide-14.png",
  "https://static.vm0.io/vm0/artifact-templates/presentation/37616a8a-7386-49f2-8e18-198a2a234d4a/slide-15.png",
] as const;

function expectStaticPreviewImages(
  item: (typeof PRESENTATION_TEMPLATE_PICKER_ITEMS)[number],
): void {
  expect(item.previewImages.length).toBeGreaterThan(0);
  expect(item.previewImage).toBe(item.previewImages[0]);

  for (const url of item.previewImages) {
    expect(url).toMatch(
      /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/presentation\/.+\.png$/,
    );
  }

  const assetUrls = [
    item.previewImage,
    item.cardPreviewImage,
    item.embedUrl,
    ...item.previewImages,
  ];

  for (const url of assetUrls) {
    for (const forbidden of FORBIDDEN_ASSET_URL_PARTS) {
      expect(url).not.toContain(forbidden);
    }
  }
}

function expectColorSystem(
  colorSystemId: string,
  expectedColorSystemId: string,
): void {
  expect(colorSystemId).toBe(expectedColorSystemId);
  expect(findColorSystem(colorSystemId)).toBeDefined();
}

const BATCH_PRESENTATION_PICKER_ITEMS = [
  {
    slug: "crayon-learning-deck",
    templateId: "template:html-ppt-crayon",
    colorSystemId: "color-system:prism",
  },
  {
    slug: "creative-agency-presentation",
    templateId: "template:html-ppt-creative-agency",
    colorSystemId: "color-system:coral-studio",
  },
  {
    slug: "data-report-presentation",
    templateId: "template:html-ppt-data-report",
    colorSystemId: "color-system:prism",
  },
  {
    slug: "editorial-magazine-deck",
    templateId: "template:html-ppt-editorial-magazine",
    colorSystemId: "color-system:warm-sand",
  },
  {
    slug: "landing-consulting-deck",
    templateId: "template:html-ppt-landing-consulting",
    colorSystemId: "color-system:pop-art",
  },
  {
    slug: "lumina-creative-studio",
    templateId: "template:html-ppt-lumina",
    colorSystemId: "color-system:prism",
  },
  {
    slug: "mosaic-geometric-pitch",
    templateId: "template:html-ppt-mosaic-geometric",
    colorSystemId: "color-system:carnival",
  },
  {
    slug: "playful-pop-deck",
    templateId: "template:html-ppt-playful-pop",
    colorSystemId: "color-system:pop-art",
  },
] as const;

const REFERENCE_PRESENTATION_PICKER_ITEMS = [
  {
    slug: "bloom-pitch",
    templateId: "template:html-ppt-bloom-pitch",
    colorSystemId: "color-system:carnival",
    defaultThemeId: "carnival",
  },
  {
    slug: "blueprint-academy",
    templateId: "template:html-ppt-blueprint-academy",
    colorSystemId: "color-system:forest-editorial",
    defaultThemeId: "forest-editorial",
  },
  {
    slug: "meridian",
    templateId: "template:html-ppt-meridian",
    colorSystemId: "color-system:slate-corporate",
    defaultThemeId: "slate-corporate",
  },
  {
    slug: "neo-brutalism",
    templateId: "template:html-ppt-neo-brutalism",
    colorSystemId: "color-system:mono-ink",
    defaultThemeId: "mono-ink",
  },
  {
    slug: "nocturne",
    templateId: "template:html-ppt-nocturne",
    colorSystemId: "color-system:midnight-mono",
    defaultThemeId: "midnight-mono",
  },
  {
    slug: "pixel-glitch",
    templateId: "template:html-ppt-pixel-glitch",
    colorSystemId: "color-system:bauhaus-primary",
    defaultThemeId: "bauhaus-primary",
  },
  {
    slug: "prospectus",
    templateId: "template:html-ppt-prospectus",
    colorSystemId: "color-system:slate-corporate",
    defaultThemeId: "slate-corporate",
  },
  {
    slug: "schoolhouse",
    templateId: "template:html-ppt-schoolhouse",
    colorSystemId: "color-system:bauhaus-primary",
    defaultThemeId: "bauhaus-primary",
  },
  {
    slug: "sticker-scrapbook",
    templateId: "template:html-ppt-sticker-scrapbook",
    colorSystemId: "color-system:prism",
    defaultThemeId: "prism",
  },
  {
    slug: "strata",
    templateId: "template:html-ppt-strata",
    colorSystemId: "color-system:mono-ink",
    defaultThemeId: "mono-ink",
  },
  {
    slug: "taped-consulting",
    templateId: "template:html-ppt-taped-consulting",
    colorSystemId: "color-system:slate-corporate",
    defaultThemeId: "slate-corporate",
  },
  {
    slug: "vantage",
    templateId: "template:html-ppt-vantage",
    colorSystemId: "color-system:slate-corporate",
    defaultThemeId: "slate-corporate",
  },
] as const;

function expectPinnedPickerPreviewImages(
  slug: string,
  expectedPreviewImages: readonly string[],
): void {
  const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
    return candidate.slug === slug;
  });

  expect(item).toBeDefined();
  if (!item) {
    throw new Error(`missing ${slug} picker item`);
  }

  expect(item.previewImages).toEqual(expectedPreviewImages);
  expect(item.previewImage).toBe(expectedPreviewImages[0]);
  expect(new Set(item.previewImages).size).toBe(expectedPreviewImages.length);
  expectStaticPreviewImages(item);
}

describe("presentation template items", () => {
  it("defines direct card preview assets for picker thumbnails", () => {
    for (const item of PRESENTATION_TEMPLATE_PICKER_ITEMS) {
      expect(item.cardPreviewImage, item.slug).toMatch(
        /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/presentation\/.+\.jpg$/u,
      );
      expect(item.cardPreviewImage, item.slug).not.toContain("/cdn-cgi/image/");
    }
  });

  it("defines themed first-slide card preview assets for picker thumbnails", () => {
    for (const item of PRESENTATION_TEMPLATE_PICKER_ITEMS) {
      expect(item.cardPreviewImagesByTheme, item.slug).toBeDefined();

      expect(Object.keys(item.cardPreviewImagesByTheme).sort()).toEqual(
        [...PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_THEMES].sort(),
      );
      for (const themeId of PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_THEMES) {
        const url = item.cardPreviewImagesByTheme[themeId];
        expect(url, `${item.slug}:${themeId}`).toMatch(
          /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/presentation\/.+-480x270\.jpg$/u,
        );
        expect(url, `${item.slug}:${themeId}`).not.toContain("/cdn-cgi/image/");
      }

      const defaultThemeId = item.colorSystemId.replace("color-system:", "");
      expect(item.cardPreviewImage, item.slug).toBe(
        item.cardPreviewImagesByTheme[defaultThemeId],
      );
    }
  });

  it("defines slide counts for picker presentation scrub previews", () => {
    for (const item of PRESENTATION_TEMPLATE_PICKER_ITEMS) {
      expect(item.slideCount, item.slug).toBe(15);
    }
  });

  it("resolves picker items to runbook packages and color systems", () => {
    for (const item of PRESENTATION_TEMPLATE_PICKER_ITEMS) {
      expect(
        findPresentationRunbookPackage(item.templateId),
        item.templateId,
      ).toBeDefined();
      expect(findColorSystem(item.colorSystemId)).toBeDefined();
    }
  });

  it("defines explicit preview image arrays", () => {
    for (const item of PRESENTATION_TEMPLATE_PICKER_ITEMS) {
      expect(Array.isArray(item.previewImages)).toBe(true);
    }
  });

  it("pins borderless picker preview image manifests", () => {
    expectPinnedPickerPreviewImages(
      "botane-organic-deck",
      BOTANE_BORDERLESS_PREVIEW_IMAGES,
    );
    expectPinnedPickerPreviewImages(
      "business-data-presentation",
      BUSINESS_DATA_BORDERLESS_PREVIEW_IMAGES,
    );
  });

  it("does not expose Open Design presentation registry entries", () => {
    expect(listTemplates("presentation")).toHaveLength(0);
  });

  it("keeps the playful launch picker item aligned with static assets", () => {
    const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
      return candidate.slug === "playful-launch-presentation";
    });

    expect(item).toBeDefined();
    if (!item) {
      throw new Error("missing playful-launch-presentation picker item");
    }
    expect(item.templateId).toBe("template:html-ppt-playful-launch");
    expectColorSystem(item.colorSystemId, "color-system:carnival");
    expect(item.slideCount).toBe(15);
    expect(item.previewImages.length).toBe(15);
    expect(item.previewImage).toBe(item.previewImages[0]);
    expect(item.embedUrl).toMatch(
      /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/presentation\/.+\/playful-launch-presentation\.html$/,
    );
    expectStaticPreviewImages(item);
    expect(
      findPresentationRunbookPackage(item.templateId),
      item.templateId,
    ).toBeDefined();
  });

  it("keeps the business data picker item aligned with static assets", () => {
    const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
      return candidate.slug === "business-data-presentation";
    });

    expect(item).toBeDefined();
    if (!item) {
      throw new Error("missing business-data-presentation picker item");
    }
    expect(item.templateId).toBe("template:html-ppt-business-data");
    expectColorSystem(item.colorSystemId, "color-system:berry-pop");
    expect(item.slideCount).toBe(15);
    expect(item.previewImages.length).toBe(15);
    expect(item.embedUrl).toMatch(
      /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/presentation\/.+\/business-data-presentation\.html$/,
    );
    expectStaticPreviewImages(item);
    expect(
      findPresentationRunbookPackage(item.templateId),
      item.templateId,
    ).toBeDefined();
  });

  it("keeps the batch picker items aligned with static assets and private R2 sources", () => {
    for (const expected of BATCH_PRESENTATION_PICKER_ITEMS) {
      const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
        return candidate.slug === expected.slug;
      });

      expect(item, expected.slug).toBeDefined();
      if (!item) {
        throw new Error(`missing ${expected.slug} picker item`);
      }
      expect(item.templateId).toBe(expected.templateId);
      expectColorSystem(item.colorSystemId, expected.colorSystemId);
      expect(item.slideCount).toBe(15);
      expect(item.previewImages.length).toBe(15);
      expect(item.previewImage).toBe(item.previewImages[0]);
      expect(item.embedUrl).toMatch(
        /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/presentation\/.+\/[^/]+\.html$/,
      );
      expectStaticPreviewImages(item);
      expect(
        findPresentationRunbookPackage(item.templateId),
        item.templateId,
      ).toBeDefined();
    }
  });

  it("keeps the reference picker items aligned with static assets and private R2 sources", () => {
    for (const expected of REFERENCE_PRESENTATION_PICKER_ITEMS) {
      const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
        return candidate.slug === expected.slug;
      });

      expect(item, expected.slug).toBeDefined();
      if (!item) {
        throw new Error(`missing ${expected.slug} picker item`);
      }
      expect(item.templateId).toBe(expected.templateId);
      expectColorSystem(item.colorSystemId, expected.colorSystemId);
      expect(item.slideCount).toBe(15);
      expect(item.previewImages.length).toBe(1);
      expect(item.previewImage).toBe(item.previewImages[0]);
      expect(item.embedUrl).toMatch(
        /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/presentation\/.+\/[^/]+\.html$/,
      );
      expectStaticPreviewImages(item);
      expect(item.cardPreviewImage).toBe(
        item.cardPreviewImagesByTheme[expected.defaultThemeId],
      );
      expect(
        findPresentationRunbookPackage(item.templateId),
        item.templateId,
      ).toBeDefined();
    }
  });

  it("keeps the botane picker item aligned with static assets", () => {
    const botaneItem = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
      return candidate.slug === "botane-organic-deck";
    });

    expect(botaneItem).toBeDefined();
    if (!botaneItem) {
      throw new Error("Botane picker item is missing");
    }
    expect(botaneItem.templateId).toBe("template:html-ppt-botane-organic");
    expectColorSystem(botaneItem.colorSystemId, "color-system:mauve-dusk");
    expect(botaneItem.previewImages.length).toBe(15);
    expect(botaneItem.previewImage).toBe(botaneItem.previewImages[0]);
    expect(botaneItem.embedUrl).toMatch(
      /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/presentation\/.+\/botane-organic-deck\.html$/,
    );
    expectStaticPreviewImages(botaneItem);
    expect(
      findPresentationRunbookPackage(botaneItem.templateId),
      botaneItem.templateId,
    ).toBeDefined();
  });
});
