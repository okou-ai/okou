import { describe, it, expect } from "vitest";
import { FeatureSwitchKey } from "../feature-switch-key";
import {
  isFeatureEnabled,
  getAllFeatureStates,
  filterFeatureSwitchOverrides,
  getFeatureSwitchDescriptions,
  getFeatureSwitchMetadata,
  isFeatureSwitchAvailable,
} from "../feature-switch";

describe("FeatureSwitchKey", () => {
  it("uses the canonical switch names", () => {
    expect(FeatureSwitchKey.Dummy).toBe("_dummy");
    expect(FeatureSwitchKey.Lab).toBe("_lab");
    expect(FeatureSwitchKey.SidebarSubscriptionUsage).toBe(
      "sidebarSubscriptionUsage",
    );
    expect(FeatureSwitchKey.FeishuIntegration).toBe("_feishuIntegration");
    expect(FeatureSwitchKey.OkouDebug).toBe("_debug");
    expect(FeatureSwitchKey.RealAgentInPreview).toBe("_realAgentInPreview");
    expect(FeatureSwitchKey.TestOauthConnector).toBe("_testOauthConnector");
    expect(FeatureSwitchKey.CodexExecution).toBe("_codexExecution");
    expect(FeatureSwitchKey.ChatThreadArchiving).toBe("chatThreadArchiving");
    expect(FeatureSwitchKey.BrowserNativeInput).toBe("browserNativeInput");
  });
});

describe("isFeatureEnabled", () => {
  it("defaults home task discovery to staff and honors explicit overrides", () => {
    const key = FeatureSwitchKey.HomeTaskDiscovery;
    for (const [context, enabledByDefault] of [
      [{}, false],
      [{ userId: "external-user", orgId: "external-org" }, false],
      [{ orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" }, true],
      [{ email: "BINGJIE@OKOU.AI" }, false],
    ] as const) {
      expect(isFeatureEnabled(key, context)).toBe(enabledByDefault);
      expect(getAllFeatureStates(context)[key]).toBe(enabledByDefault);
      for (const enabled of [true, false]) {
        const overridden = { ...context, overrides: { [key]: enabled } };
        expect(isFeatureEnabled(key, overridden)).toBe(enabled);
        expect(getAllFeatureStates(overridden)[key]).toBe(enabled);
      }
    }
  });

  it("defaults CJK emphasis to staff and honors explicit overrides", () => {
    const key = FeatureSwitchKey.MarkdownCjkEmphasis;
    const staff = { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" };
    for (const [context, enabled] of [
      [{}, false],
      [{ orgId: "external-org" }, false],
      [staff, true],
      [{ ...staff, overrides: { [key]: false } }, false],
      [{ orgId: "external-org", overrides: { [key]: true } }, true],
    ] as const) {
      expect(isFeatureEnabled(key, context)).toBe(enabled);
      expect(getAllFeatureStates(context)[key]).toBe(enabled);
    }
  });

  it("defaults chat email quoting to staff and honors Lab overrides", () => {
    const key = FeatureSwitchKey.ChatEmailQuote;
    const staff = { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" };
    for (const [context, enabled] of [
      [{}, false],
      [{ userId: "external-user" }, false],
      [{ orgId: "external-org" }, false],
      [{ userId: "external-user", orgId: "external-org" }, false],
      [{ orgId: "external-org", overrides: { [key]: true } }, true],
      [staff, true],
      [{ ...staff, overrides: { [key]: false } }, false],
    ] as const) {
      expect(isFeatureEnabled(key, context)).toBe(enabled);
      expect(getAllFeatureStates(context)[key]).toBe(enabled);
    }
  });

  it("keeps chat email quoting available in Lab for explicit rollout overrides", () => {
    const key = FeatureSwitchKey.ChatEmailQuote;
    expect(isFeatureSwitchAvailable(key, {})).toBe(true);
    expect(isFeatureSwitchAvailable(key, { orgId: "external-org" })).toBe(true);
    expect(
      isFeatureSwitchAvailable(key, {
        orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      }),
    ).toBe(true);
  });

  it("keeps Codex execution test-only and off for everyone without an override", () => {
    const key = FeatureSwitchKey.CodexExecution;
    expect(getFeatureSwitchMetadata()[key].rolloutStage).toBe("internal");
    for (const context of [
      {},
      { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" },
      { userId: "external-user", orgId: "external-org" },
      { email: "liangyou@okou.ai", orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" },
    ]) {
      expect(getAllFeatureStates(context)[key]).toBe(false);
      for (const enabled of [true, false]) {
        expect(
          isFeatureEnabled(key, {
            ...context,
            overrides: { [key]: enabled },
          }),
        ).toBe(enabled);
      }
    }
  });

  it("enables presentation conversion for Bingjie across workspaces", () => {
    for (const orgId of [
      undefined,
      "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      "org_nonexistent",
    ]) {
      const context = { email: "BINGJIE@OKOU.AI", orgId };
      expect(
        isFeatureEnabled(FeatureSwitchKey.PresentationConvert, context),
      ).toBe(true);
      expect(
        getAllFeatureStates(context)[FeatureSwitchKey.PresentationConvert],
      ).toBe(true);
    }
  });

  it("defaults presentation conversion off for everyone else, including staff", () => {
    for (const context of [
      {},
      { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" },
      {
        userId: "staff-colleague",
        email: "ethan@okou.ai",
        orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      },
      { userId: "external-user", orgId: "org_nonexistent" },
    ]) {
      expect(
        isFeatureEnabled(FeatureSwitchKey.PresentationConvert, context),
      ).toBe(false);
      expect(
        getAllFeatureStates(context)[FeatureSwitchKey.PresentationConvert],
      ).toBe(false);
    }
  });

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

  it("enables chat thread archiving for staff and honors explicit overrides", () => {
    for (const context of [{}, { orgId: "org_nonexistent" }]) {
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
    const staffContext = { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" };
    expect(
      isFeatureEnabled(FeatureSwitchKey.ChatThreadArchiving, staffContext),
    ).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.ChatThreadArchiving, {
        ...staffContext,
        overrides: { [FeatureSwitchKey.ChatThreadArchiving]: false },
      }),
    ).toBe(false);
  });

  it("should return true for globally enabled switch", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.Dummy, {})).toBe(true);
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

  it("should apply user overrides to a staff-default switch", () => {
    const staffOrgId = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
    expect(
      isFeatureEnabled(FeatureSwitchKey.Lab, {
        orgId: staffOrgId,
      }),
    ).toBe(true);
    expect(
      isFeatureEnabled(FeatureSwitchKey.Lab, {
        orgId: staffOrgId,
        overrides: { [FeatureSwitchKey.Lab]: false },
      }),
    ).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.Lab, {
        orgId: "org_nonexistent",
        overrides: { [FeatureSwitchKey.Lab]: true },
      }),
    ).toBe(true);
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
    expect(staffOrgStates[FeatureSwitchKey.PresentationConvert]).toBe(false);
    expect(staffOrgStates[FeatureSwitchKey.ChatThreadArchiving]).toBe(true);

    const otherOrgStates = getAllFeatureStates({
      orgId: "org_nonexistent",
    });
    expect(otherOrgStates[FeatureSwitchKey.Lab]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.OkouDebug]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.Banking]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.PresentationConvert]).toBe(false);
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

    expect(metadata[FeatureSwitchKey.Banking].rolloutStage).toBe("alpha");
    expect(metadata[FeatureSwitchKey.PresentationConvert].rolloutStage).toBe(
      "alpha",
    );
    expect(
      metadata[FeatureSwitchKey.SidebarSubscriptionUsage].rolloutStage,
    ).toBe("beta");
    expect(metadata[FeatureSwitchKey.HomeTaskDiscovery].rolloutStage).toBe(
      "beta",
    );
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
