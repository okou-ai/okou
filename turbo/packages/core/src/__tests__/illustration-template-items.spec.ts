import { describe, expect, it } from "vitest";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "../illustration-template-items";
import { findImageStyle, listImageStyles } from "../resource-registry";

describe("illustration template items", () => {
  it("resolve every image style against the resource registry", () => {
    for (const item of ILLUSTRATION_TEMPLATE_ITEMS) {
      const style = findImageStyle(item.illustrationStyleId);

      expect(style, item.illustrationStyleId).toBeDefined();
    }
  });

  it("registers the 33 image style archives", () => {
    const imageStyles = listImageStyles();

    expect(imageStyles).toHaveLength(33);
    for (const imageStyle of imageStyles) {
      expect(imageStyle.source.archive, imageStyle.id).toBeDefined();
    }
  });

  it("defines preview image arrays", () => {
    for (const item of ILLUSTRATION_TEMPLATE_ITEMS) {
      expect(item.previewImage).toMatch(
        /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/illustration\/assets\/.+\.(?:jpg|png)$/u,
      );
      expect(item.cardPreviewImage).toMatch(
        /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/illustration\/card-previews\/.+\.jpg$/u,
      );
      expect(item.cardPreviewImage).not.toContain("/cdn-cgi/image/");
    }
  });

  it("provides reference images and intrinsic dimensions for each template", () => {
    for (const item of ILLUSTRATION_TEMPLATE_ITEMS) {
      expect(item.width).toBeGreaterThan(0);
      expect(item.height).toBeGreaterThan(0);
      for (const url of item.previewImages) {
        expect(url, item.slug).toMatch(
          /^https:\/\/static\.vm0\.io\/vm0\/artifact-templates\/illustration\/assets\/.+\.(?:jpg|png)$/u,
        );
      }
    }
  });
});
