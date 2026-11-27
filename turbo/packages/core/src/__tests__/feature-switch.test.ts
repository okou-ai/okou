import { describe, it, expect } from "vitest";
import { FeatureSwitchKey } from "../feature-switch-key";
import {
  isFeatureEnabled,
  isFeatureSwitchAvailable,
  getAllFeatureStates,
  filterFeatureSwitchOverrides,
  getFeatureSwitchDescriptions,
  getFeatureSwitchMetadata,
} from "../feature-switch";

describe("FeatureSwitchKey", () => {
  it("uses the canonical switch names", () => {
    expect(FeatureSwitchKey.Dummy).toBe("_dummy");
    expect(FeatureSwitchKey.Lab).toBe("_lab");
    expect(FeatureSwitchKey.FeishuIntegration).toBe("_feishuIntegration");
    expect(FeatureSwitchKey.OkouDebug).toBe("_debug");
    expect(FeatureSwitchKey.RealAgentInPreview).toBe("_realAgentInPreview");
    expect(FeatureSwitchKey.TestOauthConnector).toBe("_testOauthConnector");
    expect(FeatureSwitchKey.CodexExecution).toBe("_codexExecution");
  });
});

describe("isFeatureEnabled", () => {
  it("limits the All chat filter rollout and its Lab overrides to staff workspaces", () => {
    const key = FeatureSwitchKey.ChatListAllFilter;
    const staff = { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" };
    const customer = { orgId: "external-org", overrides: { [key]: true } };
    expect(isFeatureSwitchAvailable(key, staff)).toBe(true);
    expect(isFeatureEnabled(key, staff)).toBe(true);
    expect(
      isFeatureEnabled(key, { ...staff, overrides: { [key]: false } }),
    ).toBe(false);
    expect(isFeatureSwitchAvailable(key, customer)).toBe(false);
    expect(isFeatureEnabled(key, customer)).toBe(false);
  });
  it("keeps native connector authorization opt-in for staff until provider registration is verified", () => {
    const key = FeatureSwitchKey.IosConnectorAppAuthorization;
    const staff = { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" };
    expect(isFeatureEnabled(key, staff)).toBe(false);
    expect(
      isFeatureEnabled(key, { ...staff, overrides: { [key]: true } }),
    ).toBe(true);
    expect(
      isFeatureEnabled(key, {
        orgId: "external-org",
        overrides: { [key]: true },
      }),
    ).toBe(false);
  });
  it.each([
    FeatureSwitchKey.MemberConnectorAccountAccess,
    FeatureSwitchKey.ComposerVoiceMessages,
    FeatureSwitchKey.HideEmptyForYou,
    FeatureSwitchKey.ArtifactLibrary,
    FeatureSwitchKey.ZipArtifactPreview,
    FeatureSwitchKey.FollowupPlaceholder,
    FeatureSwitchKey.PresentationConvert,
    FeatureSwitchKey.ArtifactUserSharing,
  ])("defaults %s to staff and honors Lab overrides", (key) => {
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

  it("enables three-point timing for everyone and honors personal overrides", () => {
    const key = FeatureSwitchKey.ArtifactThreePointTiming;
    expect(getFeatureSwitchMetadata()[key].rolloutStage).toBe("internal");
    for (const identity of [
      {},
      { orgId: "external-org" },
      { userId: "external-user", orgId: "external-org" },
      { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" },
      { userId: "staff-colleague", orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" },
      { userId: "staff-colleague", orgId: "external-org" },
    ]) {
      expect(isFeatureSwitchAvailable(key, identity)).toBe(true);
      expect(isFeatureEnabled(key, identity)).toBe(true);
      expect(getAllFeatureStates(identity)[key]).toBe(true);
      for (const enabled of [false, true]) {
        const context = { ...identity, overrides: { [key]: enabled } };
        expect(isFeatureEnabled(key, context)).toBe(enabled);
        expect(getAllFeatureStates(context)[key]).toBe(enabled);
      }
    }
  });

  it("keeps presentation format available to Bingjie across workspaces", () => {
    const key = FeatureSwitchKey.PresentationOutputFormat;
    for (const orgId of [
      undefined,
      "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      "external-org",
    ]) {
      for (const identity of [
        { userId: "user_3EWY21Oe3f15kfs3yYmbGgDb3NV" },
        { email: "BINGJIE@OKOU.AI" },
      ]) {
        const context = { ...identity, orgId };
        expect(isFeatureSwitchAvailable(key, context)).toBe(true);
        expect(isFeatureEnabled(key, context)).toBe(true);
        expect(getAllFeatureStates(context)[key]).toBe(true);
        const optedOut = { ...context, overrides: { [key]: false } };
        expect(isFeatureEnabled(key, optedOut)).toBe(false);
        expect(getAllFeatureStates(optedOut)[key]).toBe(false);
      }
    }
  });

  it("enables presentation format for staff and honors Lab overrides", () => {
    const key = FeatureSwitchKey.PresentationOutputFormat;
    const identity = {
      userId: "staff-colleague",
      orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
    };
    expect(isFeatureSwitchAvailable(key, identity)).toBe(true);
    expect(isFeatureEnabled(key, identity)).toBe(true);
    expect(getAllFeatureStates(identity)[key]).toBe(true);
    for (const enabled of [false, true]) {
      const context = { ...identity, overrides: { [key]: enabled } };
      expect(isFeatureEnabled(key, context)).toBe(enabled);
      expect(getAllFeatureStates(context)[key]).toBe(enabled);
    }
  });

  it("lets every Lab tester opt into presentation format without enabling it for everyone", () => {
    const key = FeatureSwitchKey.PresentationOutputFormat;
    for (const identity of [
      {},
      { userId: "external-user", orgId: "external-org" },
      {
        userId: "staff-colleague",
        email: "ethan@okou.ai",
        orgId: "external-org",
      },
    ]) {
      expect(isFeatureSwitchAvailable(key, identity)).toBe(true);
      expect(isFeatureEnabled(key, identity)).toBe(false);
      expect(getAllFeatureStates(identity)[key]).toBe(false);
      for (const enabled of [true, false]) {
        const context = { ...identity, overrides: { [key]: enabled } };
        expect(isFeatureEnabled(key, context)).toBe(enabled);
        expect(getAllFeatureStates(context)[key]).toBe(enabled);
      }
    }
  });

  it.each([
    FeatureSwitchKey.GeminiAntigravity,
    FeatureSwitchKey.ComputerUseAppStateDirectTransfer,
  ])(
    "allows staff to opt into %s individually, with no default access",
    (key) => {
      const staff = { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" };
      expect(getFeatureSwitchMetadata()[key].rolloutStage).toBe("internal");
      expect(isFeatureSwitchAvailable(key, staff)).toBe(true);
      expect(getAllFeatureStates(staff)[key]).toBe(false);
      expect(isFeatureEnabled(key, staff)).toBe(false);
      for (const enabled of [true, false]) {
        const context = { ...staff, overrides: { [key]: enabled } };
        expect(isFeatureEnabled(key, context)).toBe(enabled);
        expect(getAllFeatureStates(context)[key]).toBe(enabled);
      }
    },
  );

  it.each([
    FeatureSwitchKey.GeminiAntigravity,
    FeatureSwitchKey.ComputerUseAppStateDirectTransfer,
  ])(
    "ignores %s overrides outside staff workspaces, including stale opt-ins",
    (key) => {
      for (const identity of [
        {},
        { orgId: "external-org", email: "lancy@okou.ai" },
      ]) {
        const context = { ...identity, overrides: { [key]: true } };
        expect(isFeatureSwitchAvailable(key, context)).toBe(false);
        expect(isFeatureEnabled(key, context)).toBe(false);
        expect(getAllFeatureStates(context)[key]).toBe(false);
      }
    },
  );

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

  it("should return true for globally enabled switch", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.Dummy, {})).toBe(true);
  });

  it("should return true for globally enabled switch even with context", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Dummy, { userId: "any-user" }),
    ).toBe(true);
  });

  it("should return false for disabled switch without context", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.Banking, {})).toBe(false);
  });

  it("should return false for disabled switch with non-matching userId", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Banking, {
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
    expect(states[FeatureSwitchKey.Banking]).toBe(false);
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
    expect(staffOrgStates[FeatureSwitchKey.PresentationConvert]).toBe(true);

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
      overrides: { [FeatureSwitchKey.Banking]: true },
    });
    expect(states[FeatureSwitchKey.Banking]).toBe(true);
    // Non-overridden disabled feature stays false
    expect(states[FeatureSwitchKey.TestOauthConnector]).toBe(false);
  });

  it("should apply overrides to disable enabled features", () => {
    const states = getAllFeatureStates({
      overrides: { [FeatureSwitchKey.Dummy]: false },
    });
    expect(states[FeatureSwitchKey.Dummy]).toBe(false);
    // Non-overridden disabled feature stays false
    expect(states[FeatureSwitchKey.Banking]).toBe(false);
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
      expect(key).toMatch(/^[a-zA-Z0-9_]+$/u);
      expect(metadata[key]?.description).toMatch(/\S/u);
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
    expect(
      metadata[FeatureSwitchKey.OnboardingMultipleOutputs].rolloutStage,
    ).toBe("released");
    expect(metadata[FeatureSwitchKey.ComposerVoiceMessages].rolloutStage).toBe(
      "beta",
    );
    expect(metadata[FeatureSwitchKey.PresentationConvert].rolloutStage).toBe(
      "beta",
    );
    expect(
      metadata[FeatureSwitchKey.PresentationOutputFormat].rolloutStage,
    ).toBe("beta");
    expect(metadata[FeatureSwitchKey.Banking].rolloutStage).toBe("alpha");
  });
});

describe("overrides", () => {
  it("should enable a disabled feature when override is true", () => {
    expect(
      isFeatureEnabled(FeatureSwitchKey.Banking, {
        overrides: { [FeatureSwitchKey.Banking]: true },
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
        overrides: { [FeatureSwitchKey.Banking]: true },
      }),
    ).toBe(false);
  });

  it("should behave identically when no overrides provided", () => {
    expect(isFeatureEnabled(FeatureSwitchKey.Dummy, {})).toBe(true);
    expect(isFeatureEnabled(FeatureSwitchKey.Banking, {})).toBe(false);
    expect(
      isFeatureEnabled(FeatureSwitchKey.Dummy, { userId: "any-user" }),
    ).toBe(true);
  });
});
