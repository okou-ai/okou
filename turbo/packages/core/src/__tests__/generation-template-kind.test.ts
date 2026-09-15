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
    // Declared as full wire requests rather than bare `{ type }` literals so
    // this also holds `GenerationTemplateRequest` to the source contract.
    const presentation: GenerationTemplateRequest = {
      type: "presentation",
      selection: { templateId: "template:crayon" },
    };
    const illustration: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: "image-style:prism" },
    };
    const workflow: GenerationTemplateRequest = {
      type: "workflow",
      selection: { workflowTemplateId: "workflow-template:crm" },
    };
    const website: GenerationTemplateRequest = {
      type: "website",
      selection: { websiteTemplateId: "website-template:landing" },
    };
    const introVideo: GenerationTemplateRequest = {
      type: "intro-video",
      selection: { options: undefined },
    };

    expect(generationTemplateKind(presentation)).toBe("presentation");
    expect(generationTemplateKind(illustration)).toBe("illustration");
    expect(generationTemplateKind(workflow)).toBe("workflow");
    expect(generationTemplateKind(website)).toBe("website");
    // Classified by `type`, so a picker selection whose style, avatar, and
    // voice are not chosen yet is still Intro Video.
    expect(generationTemplateKind(introVideo)).toBe("intro-video");
  });

  it("splits the two products that still share the video envelope", () => {
    expect(
      generationTemplateKind(videoTemplate("video-template:kinetic")),
    ).toBe("video");
    expect(
      generationTemplateKind(videoTemplate(avatarTemplateStylePresetId(42))),
    ).toBe("avatar");
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

describe("generationTemplateIdentity reporting", () => {
  it("reports Intro Video as its own category and product identifier", () => {
    expect(
      generationTemplateIdentity({
        type: "intro-video",
        selection: { options: undefined },
      }),
    ).toStrictEqual({
      category: "intro-video",
      templateId: INTRO_VIDEO_TEMPLATE_ID,
      templateSlug: INTRO_VIDEO_TEMPLATE_ID,
      source: "builtin",
    });
  });

  it("keeps creative video and avatar apart inside the video envelope", () => {
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
