import { describe, expect, it } from "vitest";
import {
  VIDEO_TEMPLATE_ITEMS,
  findVideoTemplateItem,
} from "../video-template-items";
import { findVideoTemplate } from "../resource-registry";

describe("video template items", () => {
  const expectedOrder = [
    "video-template:epic-grandeur",
    "video-template:gourmet-documentary",
    "video-template:luxury-product",
    "video-template:shortform-viral",
    "video-template:fashion-editorial",
    "video-template:sports-performance-ad",
    "video-template:japanese-wabi-sabi",
    "video-template:hand-drawn-fantasy-anime",
    "video-template:cyberpunk-anime",
    "video-template:chinese-ink-art",
  ];

  it("resolve every video template against the resource registry", () => {
    expect(
      VIDEO_TEMPLATE_ITEMS.map((item) => {
        return item.id;
      }),
    ).toEqual(expectedOrder);

    for (const item of VIDEO_TEMPLATE_ITEMS) {
      const template = findVideoTemplate(item.id);

      expect(template, item.id).toBeDefined();
      expect(template?.kind).toBe("video-template");
      expect(template?.source.repo).toBe("okou-ai/okou-skills");
      expect(template?.source.ref).toBe("main");
      expect(template?.source.path).toBe(item.sourcePath);
      expect(item.previewImage).toMatch(
        /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/video\/.*\.jpg$/u,
      );
      expect(item.cardPreviewImage).toMatch(
        /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/video\/.+\.jpg$/u,
      );
      expect(item.cardPreviewImage).not.toContain("/cdn-cgi/image/");
      expect(item.previewVideo).toMatch(
        /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/video\/.*\.mp4$/u,
      );
      expect(item.previewWebm).toMatch(
        /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/video\/.*\.webm$/u,
      );
      expect(template).not.toHaveProperty("previewImage");
      expect(template).not.toHaveProperty("previewVideo");
    }
  });

  it("resolves historical video template ids", () => {
    expect(findVideoTemplateItem("tech-minimalist-reveal")).toBeUndefined();
    expect(findVideoTemplateItem("imax-epic-cinematic")?.id).toBe(
      "video-template:epic-grandeur",
    );
    expect(findVideoTemplateItem("luxury-watch-product")?.id).toBe(
      "video-template:luxury-product",
    );
    expect(findVideoTemplateItem("athletic-motivation")?.id).toBe(
      "video-template:sports-performance-ad",
    );
  });
});
