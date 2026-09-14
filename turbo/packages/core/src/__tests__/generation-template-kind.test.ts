import { describe, expect, it } from "vitest";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";

import { avatarTemplateStylePresetId } from "../avatar-template";
import { generationTemplateKind } from "../generation-template-kind";
import { generationTemplateIdentity } from "../generation-template-identity";
import { INTRO_VIDEO_TEMPLATE_ID } from "../intro-video-template";

function videoTemplate(stylePresetId: string): GenerationTemplateRequest {
  return { type: "video", selection: { stylePresetId } };
}

describe("generationTemplateKind", () => {
  it("reports each non-video envelope as its own wire type", () => {
    expect(
      generationTemplateKind({
        type: "presentation",
        selection: { templateId: "template:crayon" },
      }),
    ).toBe("presentation");
    expect(
      generationTemplateKind({
        type: "illustration",
        selection: { illustrationStyleId: "image-style:prism" },
      }),
    ).toBe("illustration");
    expect(
      generationTemplateKind({
        type: "workflow",
        selection: { workflowTemplateId: "workflow-template:crm" },
      }),
    ).toBe("workflow");
    expect(
      generationTemplateKind({
        type: "website",
        selection: { websiteTemplateId: "website-template:landing" },
      }),
    ).toBe("website");
  });

  it("splits the three products that share the video envelope", () => {
    expect(
      generationTemplateKind(videoTemplate("video-template:kinetic")),
    ).toBe("video");
    expect(
      generationTemplateKind(videoTemplate(avatarTemplateStylePresetId(42))),
    ).toBe("avatar");
    expect(generationTemplateKind(videoTemplate(INTRO_VIDEO_TEMPLATE_ID))).toBe(
      "intro-video",
    );
  });

  it("classifies an Intro Video selection whose settings are still unset", () => {
    // A draft can hold the selection before the user picks a style, avatar, or
    // voice. Reading the kind from the absent options object would report it as
    // creative video and hide it from its own product.
    const withoutOptions: GenerationTemplateRequest = {
      type: "video",
      selection: {
        stylePresetId: INTRO_VIDEO_TEMPLATE_ID,
        explainerOptions: undefined,
      },
    };

    expect(generationTemplateKind(withoutOptions)).toBe("intro-video");
  });

  it("does not mistake a malformed avatar preset id for an avatar", () => {
    expect(generationTemplateKind(videoTemplate("avatar-template:0"))).toBe(
      "video",
    );
    expect(generationTemplateKind(videoTemplate("avatar-template:"))).toBe(
      "video",
    );
  });
});

describe("generationTemplateIdentity video envelope reporting", () => {
  it("reports Intro Video separately from creative video and avatar", () => {
    expect(
      generationTemplateIdentity(videoTemplate(INTRO_VIDEO_TEMPLATE_ID)),
    ).toStrictEqual({
      category: "intro-video",
      templateId: INTRO_VIDEO_TEMPLATE_ID,
      templateSlug: INTRO_VIDEO_TEMPLATE_ID,
      source: "builtin",
    });
    expect(
      generationTemplateIdentity(videoTemplate("video-template:kinetic"))
        .category,
    ).toBe("video");
    expect(
      generationTemplateIdentity(videoTemplate(avatarTemplateStylePresetId(42)))
        .category,
    ).toBe("avatar");
  });
});
