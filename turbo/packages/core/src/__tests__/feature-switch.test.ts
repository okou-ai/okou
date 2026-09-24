import { describe, it, expect } from "vitest";
import { FeatureSwitchKey } from "../feature-switch-key";
import {
  isFeatureEnabled,
  getAllFeatureStates,
  filterFeatureSwitchOverrides,
  getFeatureSwitchDescriptions,
  getFeatureSwitchMetadata,
} from "../feature-switch";

describe("FeatureSwitchKey", () => {
  it("uses the canonical switch names", () => {
    expect(FeatureSwitchKey.PersonalModelProviderAccounts).toBe(
      "multipleSubscriptions",
    );
    expect(FeatureSwitchKey.Dummy).toBe("_dummy");
    expect(FeatureSwitchKey.Lab).toBe("_lab");
    expect(FeatureSwitchKey.SidebarSubscriptionUsage).toBe(
      "sidebarSubscriptionUsage",
    );
    expect(FeatureSwitchKey.FeishuIntegration).toBe("_feishuIntegration");
    expect(FeatureSwitchKey.ChatPreference).toBe("chatPreference");
    expect(FeatureSwitchKey.OkouDebug).toBe("_debug");
    expect(FeatureSwitchKey.RealAgentInPreview).toBe("_realAgentInPreview");
    expect(FeatureSwitchKey.LangfuseTrace).toBe("_langfuseTrace");
    expect(FeatureSwitchKey.TestOauthConnector).toBe("_testOauthConnector");
    expect(FeatureSwitchKey.PiMemory).toBe("piMemory");
    expect(FeatureSwitchKey.OkouModels).toBe("okouModels");
    expect(FeatureSwitchKey.ChatThreadArchiving).toBe("chatThreadArchiving");
    expect(FeatureSwitchKey.BrowserNativeInput).toBe("browserNativeInput");
  });
});

describe("isFeatureEnabled", () => {
  it("enables Browser native input for staff and honors overrides", () => {
    const external = { orgId: "org_nonexistent" };
    const staff = { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" };
    expect(isFeatureEnabled(FeatureSwitchKey.BrowserNativeInput, {})).toBe(
      false,
    );
    expect(
      isFeatureEnabled(FeatureSwitchKey.BrowserNativeInput, external),
    ).toBe(false);
    expect(isFeatureEnabled(FeatureSwitchKey.BrowserNativeInput, staff)).toBe(
      true,
    );
    expect(
      isFeatureEnabled(FeatureSwitchKey.BrowserNativeInput, {
        ...staff,
        overrides: { [FeatureSwitchKey.BrowserNativeInput]: false },
      }),
    ).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.BrowserNativeInput, {
        ...external,
        overrides: { [FeatureSwitchKey.BrowserNativeInput]: true },
      }),
    ).toBe(true);
    expect(
      getFeatureSwitchMetadata()[FeatureSwitchKey.BrowserNativeInput],
    ).toEqual({
      maintainer: "liangyou@okou.ai",
      description:
        "Create native web forms that apply user-provided values to exact managed Browser controls",
      rolloutStage: "beta",
    });
  });

  it("keeps the multi-account subscription UI on the staff organization", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.PersonalModelProviderAccounts, {
        orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      }),
    ).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.PersonalModelProviderAccounts, {
        orgId: "org_external",
      }),
    ).toBe(false);
  });

  it("enables Pi memory for staff and honors explicit overrides", () => {
    const staffOrgId = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
    for (const context of [{}, { orgId: "org_nonexistent" }]) {
      expect(isFeatureEnabled(FeatureSwitchKey.PiMemory, context)).toBe(false);
      expect(
        isFeatureEnabled(FeatureSwitchKey.PiMemory, {
          ...context,
          overrides: { [FeatureSwitchKey.PiMemory]: true },
        }),
      ).toBe(true);
    }
    const staff = { orgId: staffOrgId, userId: "staff-user" };
    expect(isFeatureEnabled(FeatureSwitchKey.PiMemory, staff)).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.PiMemory, {
        ...staff,
        overrides: { [FeatureSwitchKey.PiMemory]: false },
      }),
    ).toBe(false);
    expect(getFeatureSwitchMetadata()[FeatureSwitchKey.PiMemory]).toEqual({
      maintainer: "lancy@okou.ai",
      description:
        "Extract, consolidate, and recall memory for Pi threads in the staff organization.",
      rolloutStage: "beta",
    });
  });

  it("keeps chat thread archiving disabled by default and honors explicit overrides", () => {
    for (const context of [
      {},
      { orgId: "org_nonexistent" },
      { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" },
    ]) {
      expect(
        isFeatureEnabled(FeatureSwitchKey.ChatThreadArchiving, context),
      ).toBe(false);
      expect(
        isFeatureEnabled(FeatureSwitchKey.ChatThreadArchiving, {
          ...context,
          overrides: { [FeatureSwitchKey.ChatThreadArchiving]: true },
        }),
      ).toBe(true);
    }
  });

  it("enables OpenRouter US routing for staff and honors explicit overrides", () => {
    for (const context of [{}, { orgId: "org_nonexistent" }]) {
      expect(
        isFeatureEnabled(FeatureSwitchKey.OpenRouterUsRouting, context),
      ).toBe(false);
      expect(
        isFeatureEnabled(FeatureSwitchKey.OpenRouterUsRouting, {
          ...context,
          overrides: { [FeatureSwitchKey.OpenRouterUsRouting]: true },
        }),
      ).toBe(true);
    }
    const staffContext = { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" };
    expect(
      isFeatureEnabled(FeatureSwitchKey.OpenRouterUsRouting, staffContext),
    ).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.OpenRouterUsRouting, {
        ...staffContext,
        overrides: { [FeatureSwitchKey.OpenRouterUsRouting]: false },
      }),
    ).toBe(false);
  });

  it("enables DeepSeek alternative routing for staff and honors explicit overrides", () => {
    for (const context of [{}, { orgId: "org_nonexistent" }]) {
      expect(
        isFeatureEnabled(FeatureSwitchKey.DeepSeekAlternativeRouting, context),
      ).toBe(false);
      expect(
        isFeatureEnabled(FeatureSwitchKey.DeepSeekAlternativeRouting, {
          ...context,
          overrides: {
            [FeatureSwitchKey.DeepSeekAlternativeRouting]: true,
          },
        }),
      ).toBe(true);
    }
    const staffContext = { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" };
    expect(
      isFeatureEnabled(
        FeatureSwitchKey.DeepSeekAlternativeRouting,
        staffContext,
      ),
    ).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.DeepSeekAlternativeRouting, {
        ...staffContext,
        overrides: { [FeatureSwitchKey.DeepSeekAlternativeRouting]: false },
      }),
    ).toBe(false);
  });

  it("enables Okou models for staff and honors explicit overrides", () => {
    for (const context of [{}, { orgId: "org_nonexistent" }]) {
      expect(isFeatureEnabled(FeatureSwitchKey.OkouModels, context)).toBe(
        false,
      );
      expect(
        isFeatureEnabled(FeatureSwitchKey.OkouModels, {
          ...context,
          overrides: { [FeatureSwitchKey.OkouModels]: true },
        }),
      ).toBe(true);
    }
    const staffContext = { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" };
    expect(isFeatureEnabled(FeatureSwitchKey.OkouModels, staffContext)).toBe(
      true,
    );
    expect(
      isFeatureEnabled(FeatureSwitchKey.OkouModels, {
        ...staffContext,
        overrides: { [FeatureSwitchKey.OkouModels]: false },
      }),
    ).toBe(false);
    expect(getFeatureSwitchMetadata()[FeatureSwitchKey.OkouModels]).toEqual({
      maintainer: "liangyou@okou.ai",
      description:
        "Show the Okou 1.0 model family in Add Model for the staff organization.",
      rolloutStage: "beta",
    });
  });

  it("should return true for globally enabled switch", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.Dummy, {})).toBe(true);
    expect(isFeatureEnabled(FeatureSwitchKey.AvatarNeckSweater, {})).toBe(true);
  });

  it("should return true for globally enabled switch even with context", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Dummy, { userId: "any-user" }),
    ).toBe(true);
  });

  it("should return false for disabled switch without context", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {})).toBe(false);
  });

  it("should return false for disabled switch with non-matching userId", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {
        userId: "some-user",
      }),
    ).toBe(false);
  });

  it("enables the Monday MCP connector for staff and honors explicit overrides", () => {
    expect(FeatureSwitchKey.MondayConnector).toBe("mondayConnector");
    for (const context of [{}, { orgId: "org_nonexistent" }]) {
      expect(isFeatureEnabled(FeatureSwitchKey.MondayConnector, context)).toBe(
        false,
      );
    }
    const staffContext = { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" };
    expect(
      isFeatureEnabled(FeatureSwitchKey.MondayConnector, staffContext),
    ).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.MondayConnector, {
        ...staffContext,
        overrides: { [FeatureSwitchKey.MondayConnector]: false },
      }),
    ).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.MondayConnector, {
        overrides: { [FeatureSwitchKey.MondayConnector]: true },
      }),
    ).toBe(true);
    expect(
      getFeatureSwitchMetadata()[FeatureSwitchKey.MondayConnector],
    ).toEqual({
      maintainer: "liangyou@okou.ai",
      description: "Enable the Monday.com MCP connector",
      rolloutStage: "beta",
    });
  });

  it("enables the Plaud MCP connector for staff and honors explicit overrides", () => {
    expect(FeatureSwitchKey.PlaudConnector).toBe("plaudConnector");
    for (const context of [{}, { orgId: "org_nonexistent" }]) {
      expect(isFeatureEnabled(FeatureSwitchKey.PlaudConnector, context)).toBe(
        false,
      );
    }
    const staffContext = { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" };
    expect(
      isFeatureEnabled(FeatureSwitchKey.PlaudConnector, staffContext),
    ).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.PlaudConnector, {
        ...staffContext,
        overrides: { [FeatureSwitchKey.PlaudConnector]: false },
      }),
    ).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.PlaudConnector, {
        overrides: { [FeatureSwitchKey.PlaudConnector]: true },
      }),
    ).toBe(true);
    expect(getFeatureSwitchMetadata()[FeatureSwitchKey.PlaudConnector]).toEqual(
      {
        maintainer: "liangyou@okou.ai",
        description: "Enable the Plaud MCP connector",
        rolloutStage: "beta",
      },
    );
  });

  it("should return true when orgId hash matches enabledOrgIdHashes", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Lab, {
        orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      }),
    ).toBe(true);
  });

  it("should return false when orgId does not match enabledOrgIdHashes", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Lab, {
        orgId: "org_nonexistent",
      }),
    ).toBe(false);
  });

  it("should return false when no orgId provided but switch has enabledOrgIdHashes", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.Lab, {})).toBe(false);
  });

  it("should offer color themes to every workspace and accept an opt-out", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.GradientColorThemes, {
        orgId: "org_nonexistent",
      }),
    ).toBe(true);
    expect(isFeatureEnabled(FeatureSwitchKey.GradientColorThemes, {})).toBe(
      true,
    );
    expect(
      isFeatureEnabled(FeatureSwitchKey.GradientColorThemes, {
        overrides: { [FeatureSwitchKey.GradientColorThemes]: false },
      }),
    ).toBe(false);
    expect(
      getFeatureSwitchMetadata()[FeatureSwitchKey.GradientColorThemes]
        .rolloutStage,
    ).toBe("released");
  });

  it("should link user message urls for every reader and accept an opt-out", () => {
    expect(FeatureSwitchKey.UserMessageLinks).toBe("userMessageLinks");
    // A share link is read without a session, so the signed-out visitor's
    // empty context has to carry the feature too.
    for (const context of [{}, { orgId: "org_nonexistent" }]) {
      expect(isFeatureEnabled(FeatureSwitchKey.UserMessageLinks, context)).toBe(
        true,
      );
    }
    expect(
      isFeatureEnabled(FeatureSwitchKey.UserMessageLinks, {
        orgId: "org_nonexistent",
        overrides: { [FeatureSwitchKey.UserMessageLinks]: false },
      }),
    ).toBe(false);
    expect(
      getFeatureSwitchMetadata()[FeatureSwitchKey.UserMessageLinks]
        .rolloutStage,
    ).toBe("released");
  });

  it("should default Langfuse tracing off for every org and accept user overrides", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.LangfuseTrace, {
        orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      }),
    ).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.LangfuseTrace, {
        orgId: "org_nonexistent",
      }),
    ).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.LangfuseTrace, {
        userId: "any-user",
        orgId: "org_nonexistent",
        overrides: { [FeatureSwitchKey.LangfuseTrace]: true },
      }),
    ).toBe(true);
  });

  it("should apply user overrides to the staff-default Official Workflows switch", () => {
    const staffOrgId = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
    expect(
      isFeatureEnabled(FeatureSwitchKey.OfficialWorkflows, {
        orgId: staffOrgId,
      }),
    ).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.OfficialWorkflows, {
        orgId: staffOrgId,
        overrides: { [FeatureSwitchKey.OfficialWorkflows]: false },
      }),
    ).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.OfficialWorkflows, {
        orgId: "org_nonexistent",
        overrides: { [FeatureSwitchKey.OfficialWorkflows]: true },
      }),
    ).toBe(true);
  });

  it("should release Morning Brief independently and preserve false overrides", () => {
    const ordinaryOrgId = "org_nonexistent";
    expect(FeatureSwitchKey.MorningBrief).toBe("morningBrief");
    expect(isFeatureEnabled(FeatureSwitchKey.MorningBrief, {})).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.MorningBrief, {
        orgId: ordinaryOrgId,
      }),
    ).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.MorningBrief, {
        orgId: ordinaryOrgId,
        overrides: { [FeatureSwitchKey.MorningBrief]: false },
      }),
    ).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.OfficialWorkflows, {
        orgId: ordinaryOrgId,
      }),
    ).toBe(false);
    expect(getFeatureSwitchMetadata()[FeatureSwitchKey.MorningBrief]).toEqual({
      maintainer: "lancy@okou.ai",
      description:
        "Enable Morning Brief and email subscription management in Preferences.",
      rolloutStage: "released",
    });
  });

  it("should select native Morning Brief for staff while preserving the persisted key and overrides", () => {
    expect(FeatureSwitchKey.NativeMorningBrief).toBe("simpleMorningBrief");
    for (const context of [{}, { orgId: "org_nonexistent" }]) {
      expect(
        isFeatureEnabled(FeatureSwitchKey.NativeMorningBrief, context),
      ).toBe(false);
      // Selecting the replacement implementation never changes whether the
      // user has Morning Brief.
      expect(isFeatureEnabled(FeatureSwitchKey.MorningBrief, context)).toBe(
        true,
      );
    }
    const staff = { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" };
    expect(isFeatureEnabled(FeatureSwitchKey.NativeMorningBrief, staff)).toBe(
      true,
    );
    expect(isFeatureEnabled(FeatureSwitchKey.MorningBrief, staff)).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.NativeMorningBrief, {
        ...staff,
        overrides: { [FeatureSwitchKey.NativeMorningBrief]: false },
      }),
    ).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.NativeMorningBrief, {
        orgId: "org_nonexistent",
        overrides: { [FeatureSwitchKey.NativeMorningBrief]: true },
      }),
    ).toBe(true);
    expect(
      getFeatureSwitchMetadata()[FeatureSwitchKey.NativeMorningBrief],
    ).toMatchObject({
      displayName: "Native Morning Brief",
      rolloutStage: "beta",
    });
  });

  it("should return true when orgId matches even if userId does not", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Lab, {
        userId: "non-matching-user",
        orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      }),
    ).toBe(true);
  });
});

describe("getAllFeatureStates", () => {
  it("should return states for all feature switches", () => {
    const states = getAllFeatureStates();
    // Globally enabled switches should be true
    expect(states[FeatureSwitchKey.Dummy]).toBe(true);
  });

  it("should enable switches when orgId matches enabledOrgIdHashes", () => {
    const states = getAllFeatureStates({
      orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
    });
    expect(states[FeatureSwitchKey.Lab]).toBe(true);
    // Globally enabled should still be true
    expect(states[FeatureSwitchKey.Dummy]).toBe(true);
    // Switches without org hashes should remain false
    expect(states[FeatureSwitchKey.AhrefsConnector]).toBe(false);
  });

  it("should return false for switches with orgId hashes when orgId does not match", () => {
    const states = getAllFeatureStates({
      orgId: "org_nonexistent",
    });
    expect(states[FeatureSwitchKey.Lab]).toBe(false);
    expect(states[FeatureSwitchKey.Dummy]).toBe(true);
  });

  it("should reflect the current staff org rollout matrix", () => {
    const staffOrgStates = getAllFeatureStates({
      orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
    });
    expect(staffOrgStates[FeatureSwitchKey.Lab]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.SocialDataJobs]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.OkouDebug]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.Banking]).toBe(false);
    expect(staffOrgStates[FeatureSwitchKey.PiMemory]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.ChatPreference]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.PaidToolControls]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.SettingsToolsTab]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.PresentationConvert]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.PersonalModelProviderAccounts]).toBe(
      true,
    );
    expect(staffOrgStates[FeatureSwitchKey.GradientColorThemes]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.OfficialWorkflows]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.MorningBrief]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.ChatThreadHeaderActions]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.ChatThreadArchiving]).toBe(false);
    expect(staffOrgStates[FeatureSwitchKey.CustomTemplates]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.UserMessageLinks]).toBe(true);

    const otherOrgStates = getAllFeatureStates({
      orgId: "org_nonexistent",
    });
    expect(otherOrgStates[FeatureSwitchKey.Lab]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.SocialDataJobs]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.UserMessageLinks]).toBe(true);
    expect(otherOrgStates[FeatureSwitchKey.OkouDebug]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.Banking]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.PiMemory]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.ChatPreference]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.PaidToolControls]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.SettingsToolsTab]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.PresentationConvert]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.PersonalModelProviderAccounts]).toBe(
      false,
    );
    expect(otherOrgStates[FeatureSwitchKey.GradientColorThemes]).toBe(true);
    expect(otherOrgStates[FeatureSwitchKey.OfficialWorkflows]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.MorningBrief]).toBe(true);
    expect(otherOrgStates[FeatureSwitchKey.ChatThreadHeaderActions]).toBe(
      false,
    );
    expect(otherOrgStates[FeatureSwitchKey.CustomTemplates]).toBe(false);
  });

  it("enables Pi memory for staff colleagues unless they opt out", () => {
    const staffOrgId = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
    const testerStates = getAllFeatureStates({
      orgId: staffOrgId,
      userId: "pi-memory-tester",
    });
    expect(testerStates[FeatureSwitchKey.PiMemory]).toBe(true);

    const colleagueStates = getAllFeatureStates({
      orgId: staffOrgId,
      userId: "pi-memory-colleague",
    });
    expect(colleagueStates[FeatureSwitchKey.PiMemory]).toBe(true);

    const optedOutStates = getAllFeatureStates({
      orgId: staffOrgId,
      userId: "pi-memory-colleague",
      overrides: { [FeatureSwitchKey.PiMemory]: false },
    });
    expect(optedOutStates[FeatureSwitchKey.PiMemory]).toBe(false);
  });

  it("should enable custom templates for Bingjie by email outside the staff org", () => {
    const bingjieStates = getAllFeatureStates({
      email: "BINGJIE@OKOU.AI",
      orgId: "org_nonexistent",
    });
    expect(bingjieStates[FeatureSwitchKey.CustomTemplates]).toBe(true);

    const otherStates = getAllFeatureStates({
      email: "ethan@okou.ai",
      orgId: "org_nonexistent",
    });
    expect(otherStates[FeatureSwitchKey.CustomTemplates]).toBe(false);
  });

  it("should apply overrides to enable disabled features", () => {
    const states = getAllFeatureStates({
      overrides: { [FeatureSwitchKey.AhrefsConnector]: true },
    });
    expect(states[FeatureSwitchKey.AhrefsConnector]).toBe(true);
    // Non-overridden disabled feature stays false
    expect(states[FeatureSwitchKey.TestOauthConnector]).toBe(false);
  });

  it("should apply overrides to disable enabled features", () => {
    const states = getAllFeatureStates({
      overrides: { [FeatureSwitchKey.Dummy]: false },
    });
    expect(states[FeatureSwitchKey.Dummy]).toBe(false);
    // Non-overridden disabled feature stays false
    expect(states[FeatureSwitchKey.AhrefsConnector]).toBe(false);
  });

  it("should ignore override keys that are no longer registered", () => {
    const states = getAllFeatureStates({
      overrides: {
        removedFeature: true,
      } as Partial<Record<FeatureSwitchKey, boolean>>,
    });

    expect("removedFeature" in states).toBe(false);
  });
});

describe("feature switch override filtering", () => {
  it("keeps registered overrides when the input also contains unknown keys", () => {
    const switches = Object.fromEntries(
      Object.values(FeatureSwitchKey).map((key) => {
        return [key, true];
      }),
    );

    expect(
      filterFeatureSwitchOverrides({ ...switches, unknownFeature: true }),
    ).toStrictEqual(switches);
  });
});

describe("getFeatureSwitchDescriptions", () => {
  it("should return a record with all feature switch keys", () => {
    const descriptions = getFeatureSwitchDescriptions();
    for (const key of Object.values(FeatureSwitchKey)) {
      expect(descriptions).toHaveProperty(key);
    }
  });

  it("should return a description string for every switch", () => {
    const descriptions = getFeatureSwitchDescriptions();
    for (const key of Object.values(FeatureSwitchKey)) {
      expect(descriptions[key]).toEqual(expect.any(String));
    }
  });
});

describe("getFeatureSwitchMetadata", () => {
  it("should return display metadata for every switch", () => {
    const metadata = getFeatureSwitchMetadata();
    for (const key of Object.values(FeatureSwitchKey)) {
      expect(metadata[key]?.maintainer).toMatch(/@okou\.ai$/u);
      expect(metadata[key]?.description).toEqual(expect.any(String));
      expect(metadata[key]?.rolloutStage).toMatch(
        /^(released|beta|alpha|internal)$/u,
      );
    }
  });

  it("should classify only underscore-prefixed switches as internal", () => {
    const metadata = getFeatureSwitchMetadata();

    for (const key of Object.values(FeatureSwitchKey)) {
      if (key.startsWith("_")) {
        expect(metadata[key].rolloutStage).toBe("internal");
      } else {
        expect(metadata[key].rolloutStage).not.toBe("internal");
      }
    }
  });

  it("should classify non-internal switches by rollout audience", () => {
    const metadata = getFeatureSwitchMetadata();

    expect(metadata[FeatureSwitchKey.AvatarNeckSweater].rolloutStage).toBe(
      "released",
    );
    expect(metadata[FeatureSwitchKey.Banking].rolloutStage).toBe("alpha");
    expect(metadata[FeatureSwitchKey.CustomTemplates].rolloutStage).toBe(
      "beta",
    );
    expect(
      metadata[FeatureSwitchKey.PersonalModelProviderAccounts].rolloutStage,
    ).toBe("beta");
    expect(
      metadata[FeatureSwitchKey.SidebarSubscriptionUsage].rolloutStage,
    ).toBe("beta");
    expect(metadata[FeatureSwitchKey.AhrefsConnector].rolloutStage).toBe(
      "alpha",
    );
  });
});

describe("overrides", () => {
  it("should enable a disabled feature when override is true", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {
        overrides: { [FeatureSwitchKey.AhrefsConnector]: true },
      }),
    ).toBe(true);
  });

  it("should disable an enabled feature when override is false", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Dummy, {
        overrides: { [FeatureSwitchKey.Dummy]: false },
      }),
    ).toBe(false);
  });

  it("should not affect keys without overrides", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.TestOauthConnector, {
        overrides: { [FeatureSwitchKey.AhrefsConnector]: true },
      }),
    ).toBe(false);
  });

  it("should behave identically when no overrides provided", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.Dummy, {})).toBe(true);
    expect(isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {})).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.Dummy, { userId: "any-user" }),
    ).toBe(true);
  });
});
