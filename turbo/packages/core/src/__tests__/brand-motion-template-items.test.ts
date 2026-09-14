import { describe, expect, it } from "vitest";
import {
  generationTemplateRequestSchema,
  userMessageInputDocumentSchema,
  type GenerationTemplateRequest,
} from "@okouai/api-contracts/contracts/chat-threads";

import {
  BRAND_MOTION_TEMPLATE_ITEMS,
  brandMotionInstructionLines,
  brandMotionUnavailableInstructionLines,
  findBrandMotionTemplateItem,
  isBrandMotionTemplateId,
  isBrandMotionTemplateReady,
  resolveBrandMotionTemplate,
} from "../brand-motion-template-items";
import { isFeatureEnabled, getAllFeatureStates } from "../feature-switch";
import { FeatureSwitchKey } from "../feature-switch-key";
import { generationTemplateIdentity } from "../generation-template-identity";

describe("brand motion catalog", () => {
  it("preserves the approved 36 source IDs with unique namespaced selections", () => {
    expect(BRAND_MOTION_TEMPLATE_ITEMS).toHaveLength(36);
    const ids = BRAND_MOTION_TEMPLATE_ITEMS.map((item) => {
      return item.id;
    });
    expect(new Set(ids).size).toBe(36);
    expect(
      BRAND_MOTION_TEMPLATE_ITEMS.filter((item) => {
        return item.sourceTemplateId.startsWith("brand-");
      }),
    ).toHaveLength(12);
    expect(
      BRAND_MOTION_TEMPLATE_ITEMS.filter((item) => {
        return item.sourceTemplateId.startsWith("reveal-");
      }),
    ).toHaveLength(24);
    for (const item of BRAND_MOTION_TEMPLATE_ITEMS) {
      expect(item.id).toBe(`brand-motion:${item.sourceTemplateId}`);
      expect(findBrandMotionTemplateItem(item.id)).toBe(item);
      expect(findBrandMotionTemplateItem(item.slug)).toBeUndefined();
    }
    expect(isBrandMotionTemplateId("brand-motion:unknown")).toBe(true);
    expect(findBrandMotionTemplateItem("brand-motion:unknown")).toBeUndefined();
    expect(isBrandMotionTemplateId("video-template:reveal-mask")).toBe(false);
  });

  it("round-trips existing video and message contracts without adding settings", () => {
    const item = BRAND_MOTION_TEMPLATE_ITEMS[0]!;
    const selection: GenerationTemplateRequest = {
      type: "video",
      selection: { stylePresetId: item.id },
    };
    expect(generationTemplateRequestSchema.parse(selection)).toEqual(selection);
    const draft = {
      version: 1,
      parts: [
        { type: "text", text: "Animate my attached brand" },
        { type: "template", titleSnapshot: item.title, template: selection },
      ],
    };
    expect(userMessageInputDocumentSchema.parse(draft)).toEqual(draft);
    expect(generationTemplateIdentity(selection)).toEqual({
      category: "brand-motion",
      templateId: item.id,
      templateSlug: item.sourceTemplateId,
      source: "builtin",
    });
    expect(
      generationTemplateIdentity({
        type: "video",
        selection: { stylePresetId: "video-template:cinematic" },
      }).category,
    ).toBe("video");
    expect(
      generationTemplateIdentity({
        type: "video",
        selection: { stylePresetId: "avatar-template:123" },
      }).category,
    ).toBe("avatar");
  });

  it("rejects disabled, unknown and pending selections without generic video fallback", () => {
    for (const item of BRAND_MOTION_TEMPLATE_ITEMS) {
      expect(resolveBrandMotionTemplate(item.id, false)).toStrictEqual({
        status: "invalid",
        message: "Brand motion is not available",
      });
      expect(resolveBrandMotionTemplate(item.id, true)).toStrictEqual({
        status: "invalid",
        message: "Brand motion template resources are not available yet",
      });
    }
    expect(
      resolveBrandMotionTemplate("brand-motion:unknown", true),
    ).toStrictEqual({
      status: "invalid",
      message: "Unknown brand motion template",
    });
    const context = brandMotionUnavailableInstructionLines(
      "Brand motion is not available",
    ).join("\n");
    expect(context).toContain("Explain this unavailability to the user");
    expect(context).toContain(
      "Do not fulfill this Brand motion request with another motion or generic video generation",
    );
    expect(context).not.toContain("Use the $brand-motion skill");
  });

  it.each([null, "", "   "])(
    "rejects an unconfigured source path %s",
    (sourcePath) => {
      expect(
        isBrandMotionTemplateReady({
          ...BRAND_MOTION_TEMPLATE_ITEMS[0]!,
          sourcePath,
        }),
      ).toBe(false);
    },
  );

  it("uses the canonical skill and selected source without requiring preview media", () => {
    const item = {
      ...BRAND_MOTION_TEMPLATE_ITEMS[0]!,
      sourcePath: "compositions/precision.html",
      previewImage: null,
      previewVideo: null,
    };
    expect(isBrandMotionTemplateReady(item)).toBe(true);
    const prompt = brandMotionInstructionLines(item).join("\n");
    expect(prompt).toContain("Use the $brand-motion skill");
    expect(prompt).toContain(`Source template ID: ${item.sourceTemplateId}`);
    expect(prompt).toContain(
      `Composition path within the skill: ${item.sourcePath}`,
    );
    expect(prompt).toContain(
      "Ask in chat when a required brand asset is missing",
    );
    expect(prompt).toContain("default 0.25-second end hold");
    expect(prompt).toContain("one playable MP4");
    expect(prompt).not.toContain("okou generate video");
    expect(prompt).not.toContain("https://");
  });

  it("exposes the switch as default off and honors an explicit override", () => {
    expect(getAllFeatureStates({})[FeatureSwitchKey.BrandMotion]).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.BrandMotion, {
        overrides: { [FeatureSwitchKey.BrandMotion]: true },
      }),
    ).toBe(true);
  });
});
