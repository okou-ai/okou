import { describe, expect, it } from "vitest";
import { r2ImageTransformUrl } from "../r2-image-transform";

describe("r2ImageTransformUrl", () => {
  it("wraps a complete R2 presign without changing its path or signature", () => {
    const url =
      `https://${"a".repeat(32)}.r2.cloudflarestorage.com/private/photo%20%2B.png` +
      "?X-Amz-Credential=key%2F20260911%2Fauto%2Fs3%2Faws4_request" +
      "&X-Amz-Security-Token=token%2B%2F%3D&X-Amz-Expires=172800" +
      "&response-cache-control=private%2C%20no-store&X-Amz-Signature=signature#preview";
    expect(
      r2ImageTransformUrl(
        url,
        { width: 800, height: 720 },
        "https://cdn.vm7.io",
      ),
    ).toBe(
      `https://cdn.vm7.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/${url}`,
    );
  });

  it("does not forward unrelated signed URLs to the image service", () => {
    const url = "https://example.com/photo.png?X-Amz-Signature=signature";
    expect(r2ImageTransformUrl(url, { width: 800 }, "https://cdn.vm7.io")).toBe(
      url,
    );
  });

  it.each([
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/private/photo.BMP?X-Amz-Signature=signature#preview`,
    "https://a.okou.io/0123456789.bmp?download=1#preview",
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/private/photo.tiff?X-Amz-Signature=signature`,
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/private/image?X-Amz-Signature=signature`,
  ])(
    "keeps unsupported or unknown image inputs on their original URL: %s",
    (url) => {
      expect(
        r2ImageTransformUrl(url, { width: 800 }, "https://cdn.vm7.io"),
      ).toBe(url);
    },
  );

  it("keeps public shares on their policy-checked URL", () => {
    const url = `https://a.okou.io/${"a".repeat(24)}.png?download=1#preview`;
    expect(r2ImageTransformUrl(url, { width: 400, height: 300 })).toBe(url);
  });

  it("continues resizing historical short artifact URLs", () => {
    expect(
      r2ImageTransformUrl("https://a.okou.io/0123456789.png", { width: 400 }),
    ).toBe(
      "https://a.okou.io/cdn-cgi/image/width=400,fit=scale-down,format=auto,quality=85,metadata=none/0123456789.png",
    );
  });

  it("adds image transform directives for vm0 CDN artifact URLs", () => {
    expect(
      r2ImageTransformUrl("https://cdn.vm0.io/artifacts/user/id/image.png", {
        width: 320,
        height: 180,
      }),
    ).toBe(
      "https://cdn.vm0.io/cdn-cgi/image/width=320,height=180,fit=scale-down,format=auto,quality=85,metadata=none/artifacts/user/id/image.png",
    );
  });

  it("supports vm7 CDN artifact URLs", () => {
    expect(
      r2ImageTransformUrl("https://cdn.vm7.io/artifacts/user/id/image.jpg", {
        width: 96,
        height: 96,
      }),
    ).toBe(
      "https://cdn.vm7.io/cdn-cgi/image/width=96,height=96,fit=scale-down,format=auto,quality=85,metadata=none/artifacts/user/id/image.jpg",
    );
  });

  it("supports Okou CDN artifact URLs", () => {
    expect(
      r2ImageTransformUrl("https://cdn.okou.io/artifacts/user/id/image.jpg", {
        width: 96,
        height: 96,
      }),
    ).toBe(
      "https://cdn.okou.io/cdn-cgi/image/width=96,height=96,fit=scale-down,format=auto,quality=85,metadata=none/artifacts/user/id/image.jpg",
    );
  });

  it("supports static vm0 asset URLs", () => {
    expect(
      r2ImageTransformUrl(
        "https://static.vm0.io/vm0/artifact-templates/video/id/image.jpg",
        { width: 480, height: 270 },
      ),
    ).toBe(
      "https://static.vm0.io/cdn-cgi/image/width=480,height=270,fit=scale-down,format=auto,quality=85,metadata=none/vm0/artifact-templates/video/id/image.jpg",
    );
  });

  it("supports static Okou asset URLs", () => {
    expect(
      r2ImageTransformUrl(
        "https://static.okou.io/okou/artifact-templates/video/id/image.jpg",
        { width: 480, height: 270 },
      ),
    ).toBe(
      "https://static.okou.io/cdn-cgi/image/width=480,height=270,fit=scale-down,format=auto,quality=85,metadata=none/okou/artifact-templates/video/id/image.jpg",
    );
  });

  it("preserves search params and hashes", () => {
    expect(
      r2ImageTransformUrl(
        "https://cdn.vm0.io/artifacts/user/id/image.png?token=abc#preview",
        { width: 800 },
      ),
    ).toBe(
      "https://cdn.vm0.io/cdn-cgi/image/width=800,fit=scale-down,format=auto,quality=85,metadata=none/artifacts/user/id/image.png?token=abc#preview",
    );
  });

  it("allows callers to tune output quality", () => {
    expect(
      r2ImageTransformUrl("https://cdn.vm0.io/artifacts/user/id/image.jpg", {
        width: 768,
        height: 768,
        quality: 72,
      }),
    ).toBe(
      "https://cdn.vm0.io/cdn-cgi/image/width=768,height=768,fit=scale-down,format=auto,quality=72,metadata=none/artifacts/user/id/image.jpg",
    );
  });

  it("allows callers to crop cover thumbnails", () => {
    expect(
      r2ImageTransformUrl("https://cdn.vm0.io/artifacts/user/id/image.jpg", {
        width: 96,
        height: 96,
        fit: "cover",
        quality: 65,
      }),
    ).toBe(
      "https://cdn.vm0.io/cdn-cgi/image/width=96,height=96,fit=cover,format=auto,quality=65,metadata=none/artifacts/user/id/image.jpg",
    );
  });

  it("leaves already transformed URLs untouched", () => {
    const url =
      "https://cdn.vm0.io/cdn-cgi/image/width=100,height=100,fit=scale-down/artifacts/user/id/image.png";

    expect(r2ImageTransformUrl(url, { width: 400, height: 300 })).toBe(url);
  });

  it("leaves non-R2 URLs untouched", () => {
    const url = "https://example.com/image.png";
    expect(r2ImageTransformUrl(url, { width: 400, height: 300 })).toBe(url);
    expect(r2ImageTransformUrl("/local/image.png", { width: 400 })).toBe(
      "/local/image.png",
    );
  });
});
