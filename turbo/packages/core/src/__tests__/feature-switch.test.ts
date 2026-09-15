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
  it("uses the canonical internal switch names", () => {
    expect(FeatureSwitchKey.PersonalModelProviderAccounts).toBe(
      "_multipleSubscriptions",
    );
    expect(FeatureSwitchKey.Dummy).toBe("_dummy");
    expect(FeatureSwitchKey.Lab).toBe("_lab");
    expect(FeatureSwitchKey.SidebarSubscriptionUsage).toBe(
      "_sidebarSubscriptionUsage",
    );
    expect(FeatureSwitchKey.FeishuIntegration).toBe("_feishuIntegration");
    expect(FeatureSwitchKey.CodexFastMode).toBe("_fastModel");
    expect(FeatureSwitchKey.ChatPreference).toBe("chatPreference");
    expect(FeatureSwitchKey.OkouDebug).toBe("_debug");
    expect(FeatureSwitchKey.RealAgentInPreview).toBe("_realAgentInPreview");
    expect(FeatureSwitchKey.LangfuseTrace).toBe("_langfuseTrace");
    expect(FeatureSwitchKey.TestOauthConnector).toBe("_testOauthConnector");
    expect(FeatureSwitchKey.SshAccess).toBe("sshAccess");
    expect(FeatureSwitchKey.PiLoop).toBe("piLoop");
    expect(FeatureSwitchKey.PiMemory).toBe("piMemory");
  });
});

describe("isFeatureEnabled", () => {
  it("keeps Pi memory off for everyone until an explicit override enables it", () => {
    const staffOrgId = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
    for (const context of [
      {},
      { orgId: "org_nonexistent" },
      { orgId: staffOrgId },
      { orgId: staffOrgId, userId: "staff-user", email: "lancy@okou.ai" },
    ]) {
      expect(isFeatureEnabled(FeatureSwitchKey.PiMemory, context)).toBe(false);
      expect(
        isFeatureEnabled(FeatureSwitchKey.PiMemory, {
          ...context,
          overrides: { [FeatureSwitchKey.PiMemory]: true },
        }),
      ).toBe(true);
    }
    // PiLoop selects the runtime and stays independent of PiMemory.
    expect(
      isFeatureEnabled(FeatureSwitchKey.PiLoop, {
        orgId: staffOrgId,
        overrides: { [FeatureSwitchKey.PiMemory]: false },
      }),
    ).toBe(true);
    expect(getFeatureSwitchMetadata()[FeatureSwitchKey.PiMemory]).toEqual({
      maintainer: "lancy@okou.ai",
      description:
        "Extract, consolidate, and recall memory for Pi threads. Off for everyone, including the staff org; enabled one user at a time through explicit overrides.",
      rolloutStage: "alpha",
    });
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
    expect(isFeatureEnabled(FeatureSwitchKey.SshAccess, {})).toBe(false);
    expect(getFeatureSwitchMetadata()[FeatureSwitchKey.SshAccess]).toEqual({
      maintainer: "liangyou@okou.ai",
      description: "Enable standalone Runner-mediated SSH configuration",
      rolloutStage: "beta",
    });
  });

  it("should return false for disabled switch with non-matching userId", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.AhrefsConnector, {
        userId: "some-user",
      }),
    ).toBe(false);
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

  it("should enable the Welcome Thread switch for the staff org only", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.WelcomeThread, {
        orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      }),
    ).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.WelcomeThread, {
        orgId: "org_nonexistent",
      }),
    ).toBe(false);
    expect(isFeatureEnabled(FeatureSwitchKey.WelcomeThread, {})).toBe(false);
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
    expect(staffOrgStates[FeatureSwitchKey.OkouDebug]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.Banking]).toBe(false);
    expect(staffOrgStates[FeatureSwitchKey.PiLoop]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.PiMemory]).toBe(false);
    expect(staffOrgStates[FeatureSwitchKey.ChatPreference]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.CustomConnectorMcp]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.PersonalModelProviderAccounts]).toBe(
      true,
    );
    expect(staffOrgStates[FeatureSwitchKey.ChatTranslation]).toBe(false);
    expect(staffOrgStates[FeatureSwitchKey.IntroVideo]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.GradientColorThemes]).toBe(false);
    expect(staffOrgStates[FeatureSwitchKey.OfficialWorkflows]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.MorningBrief]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.SshAccess]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.ChatThreadHeaderActions]).toBe(true);

    const otherOrgStates = getAllFeatureStates({
      orgId: "org_nonexistent",
    });
    expect(otherOrgStates[FeatureSwitchKey.Lab]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.OkouDebug]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.Banking]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.PiLoop]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.PiMemory]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.ChatPreference]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.CustomConnectorMcp]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.PersonalModelProviderAccounts]).toBe(
      false,
    );
    expect(otherOrgStates[FeatureSwitchKey.ChatTranslation]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.IntroVideo]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.GradientColorThemes]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.OfficialWorkflows]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.MorningBrief]).toBe(true);
    expect(otherOrgStates[FeatureSwitchKey.ChatThreadHeaderActions]).toBe(
      false,
    );
  });

  it("enables Pi memory only for the user whose override says so", () => {
    const staffOrgId = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
    const testerStates = getAllFeatureStates({
      orgId: staffOrgId,
      userId: "pi-memory-tester",
      overrides: { [FeatureSwitchKey.PiMemory]: true },
    });
    expect(testerStates[FeatureSwitchKey.PiMemory]).toBe(true);
    expect(testerStates[FeatureSwitchKey.PiLoop]).toBe(true);

    const colleagueStates = getAllFeatureStates({
      orgId: staffOrgId,
      userId: "pi-memory-colleague",
    });
    expect(colleagueStates[FeatureSwitchKey.PiMemory]).toBe(false);
    expect(colleagueStates[FeatureSwitchKey.PiLoop]).toBe(true);
  });

  it("should enable model selection refactoring for Bingjie by email outside the staff org", () => {
    const bingjieStates = getAllFeatureStates({
      email: "BINGJIE@OKOU.AI",
      orgId: "org_nonexistent",
    });
    expect(bingjieStates[FeatureSwitchKey.RefactorModelSelect]).toBe(true);

    const otherStates = getAllFeatureStates({
      email: "ethan@okou.ai",
      orgId: "org_nonexistent",
    });
    expect(otherStates[FeatureSwitchKey.RefactorModelSelect]).toBe(false);
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
    expect(metadata[FeatureSwitchKey.IntroVideo].rolloutStage).toBe("beta");
    expect(metadata[FeatureSwitchKey.WelcomeThread].rolloutStage).toBe("beta");
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
