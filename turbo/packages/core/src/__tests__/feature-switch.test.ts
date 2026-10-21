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
    expect(FeatureSwitchKey.PiMemory).toBe("piMemory");
    expect(FeatureSwitchKey.CodexExecution).toBe("_codexExecution");
    expect(FeatureSwitchKey.ChatThreadArchiving).toBe("chatThreadArchiving");
    expect(FeatureSwitchKey.BrowserNativeInput).toBe("browserNativeInput");
  });
});

describe("isFeatureEnabled", () => {
  it("limits the PWA keyboard viewport rollout to Bingjie across workspaces", () => {
    const key = FeatureSwitchKey.PwaKeyboardViewport;
    for (const orgId of [
      undefined,
      "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      "org_nonexistent",
    ]) {
      expect(isFeatureEnabled(key, { email: "BINGJIE@OKOU.AI", orgId })).toBe(
        true,
      );
      expect(isFeatureEnabled(key, { email: "ethan@okou.ai", orgId })).toBe(
        false,
      );
      expect(isFeatureEnabled(key, { orgId })).toBe(false);
      expect(
        isFeatureEnabled(key, {
          email: "bingjie@okou.ai",
          orgId,
          overrides: { [key]: false },
        }),
      ).toBe(false);
    }
  });

  it("targets remote setup only to Bingjie's verified product identity", () => {
    const key = FeatureSwitchKey.RemoteControlGuidedSetup;
    const userId = "user_3EWY21Oe3f15kfs3yYmbGgDb3NV";
    for (const orgId of [
      undefined,
      "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      "external-org",
    ]) {
      expect(isFeatureEnabled(key, { userId, orgId })).toBe(true);
      expect(getAllFeatureStates({ userId, orgId })[key]).toBe(true);
      expect(isFeatureSwitchAvailable(key, { userId, orgId })).toBe(true);
      expect(
        getAllFeatureStates({ userId, orgId, overrides: { [key]: false } })[
          key
        ],
      ).toBe(false);
    }
    for (const context of [
      {},
      { email: "bingjie@okou.ai" },
      { orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" },
      {
        userId: "staff-colleague",
        email: "ethan@okou.ai",
        orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      },
      { userId: "external-user", orgId: "external-org" },
    ]) {
      expect(isFeatureEnabled(key, context)).toBe(false);
      expect(getAllFeatureStates(context)[key]).toBe(false);
      expect(isFeatureSwitchAvailable(key, context)).toBe(false);
      const overridden = { ...context, overrides: { [key]: true } };
      expect(isFeatureEnabled(key, overridden)).toBe(false);
      expect(getAllFeatureStates(overridden)[key]).toBe(false);
    }
  });

  it("keeps remote UI, VNC, and Tailscale switch values independent", () => {
    const ui = FeatureSwitchKey.RemoteControlGuidedSetup;
    const vnc = FeatureSwitchKey.VncAccess;
    const tailscale = FeatureSwitchKey.TailscaleAccess;
    for (const uiEnabled of [false, true]) {
      for (const vncEnabled of [false, true]) {
        for (const tailscaleEnabled of [false, true]) {
          const context = {
            userId: "user_3EWY21Oe3f15kfs3yYmbGgDb3NV",
            overrides: {
              [ui]: uiEnabled,
              [vnc]: vncEnabled,
              [tailscale]: tailscaleEnabled,
            },
          };
          const actual = getAllFeatureStates(context);
          for (const [key, expected] of Object.entries(context.overrides)) {
            expect(actual[key as FeatureSwitchKey]).toBe(expected);
            expect(isFeatureEnabled(key as FeatureSwitchKey, context)).toBe(
              expected,
            );
          }
          const withoutUi = getAllFeatureStates({
            ...context,
            overrides: { ...context.overrides, [ui]: !uiEnabled },
          });
          expect({ ...actual, [ui]: undefined }).toEqual({
            ...withoutUi,
            [ui]: undefined,
          });
        }
      }
    }
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
    expect(staffOrgStates[FeatureSwitchKey.PiMemory]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.PresentationConvert]).toBe(false);
    expect(staffOrgStates[FeatureSwitchKey.ChatThreadArchiving]).toBe(true);
    expect(staffOrgStates[FeatureSwitchKey.CustomTemplates]).toBe(true);

    const otherOrgStates = getAllFeatureStates({
      orgId: "org_nonexistent",
    });
    expect(otherOrgStates[FeatureSwitchKey.Lab]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.OkouDebug]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.Banking]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.PiMemory]).toBe(false);
    expect(otherOrgStates[FeatureSwitchKey.PresentationConvert]).toBe(false);
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

    expect(metadata[FeatureSwitchKey.Banking].rolloutStage).toBe("alpha");
    expect(metadata[FeatureSwitchKey.PresentationConvert].rolloutStage).toBe(
      "alpha",
    );
    expect(metadata[FeatureSwitchKey.CustomTemplates].rolloutStage).toBe(
      "beta",
    );
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

describe("remote UI rollout", () => {
  it.each([
    "user_3EWY21Oe3f15kfs3yYmbGgDb3NV",
    "user_3G9pYGWE2oaAQAUfb8wIwcLxwiy",
  ])("enables remote setup for Bingjie's verified identity %s", (userId) => {
    const key = FeatureSwitchKey.RemoteControlGuidedSetup;
    for (const orgId of [
      undefined,
      "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
      "external-org",
    ]) {
      expect(isFeatureEnabled(key, { userId, orgId })).toBe(true);
      expect(getAllFeatureStates({ userId, orgId })[key]).toBe(true);
      expect(isFeatureSwitchAvailable(key, { userId, orgId })).toBe(true);
      expect(
        getAllFeatureStates({ userId, orgId, overrides: { [key]: false } })[
          key
        ],
      ).toBe(false);
    }
  });

  it("enables remote setup for the staff organization with an opt-out", () => {
    const key = FeatureSwitchKey.RemoteControlGuidedSetup;
    const context = {
      userId: "staff-colleague",
      orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
    };
    expect(isFeatureEnabled(key, context)).toBe(true);
    expect(getAllFeatureStates(context)[key]).toBe(true);
    expect(isFeatureSwitchAvailable(key, context)).toBe(true);
    const disabled = { ...context, overrides: { [key]: false } };
    expect(isFeatureEnabled(key, disabled)).toBe(false);
    expect(getAllFeatureStates(disabled)[key]).toBe(false);
  });

  it("defaults remote setup off outside the rollout audience but allows opting in", () => {
    const key = FeatureSwitchKey.RemoteControlGuidedSetup;
    for (const context of [
      {},
      { email: "bingjie@okou.ai" },
      { email: "bingjie@vm0.ai" },
      {
        userId: "staff-colleague",
        email: "ethan@okou.ai",
        orgId: "external-org",
      },
      { userId: "external-user", orgId: "external-org" },
    ]) {
      expect(isFeatureEnabled(key, context)).toBe(false);
      expect(getAllFeatureStates(context)[key]).toBe(false);
      expect(isFeatureSwitchAvailable(key, context)).toBe(true);
      const overridden = { ...context, overrides: { [key]: true } };
      expect(isFeatureEnabled(key, overridden)).toBe(true);
      expect(getAllFeatureStates(overridden)[key]).toBe(true);
    }
  });

  it("keeps remote UI, VNC, and Tailscale switch values independent", () => {
    const ui = FeatureSwitchKey.RemoteControlGuidedSetup;
    const vnc = FeatureSwitchKey.VncAccess;
    const tailscale = FeatureSwitchKey.TailscaleAccess;
    for (const uiEnabled of [false, true]) {
      for (const vncEnabled of [false, true]) {
        for (const tailscaleEnabled of [false, true]) {
          const context = {
            userId: "user_3EWY21Oe3f15kfs3yYmbGgDb3NV",
            overrides: {
              [ui]: uiEnabled,
              [vnc]: vncEnabled,
              [tailscale]: tailscaleEnabled,
            },
          };
          const actual = getAllFeatureStates(context);
          for (const [key, expected] of Object.entries(context.overrides)) {
            expect(actual[key as FeatureSwitchKey]).toBe(expected);
            expect(isFeatureEnabled(key as FeatureSwitchKey, context)).toBe(
              expected,
            );
          }
          const withoutUi = getAllFeatureStates({
            ...context,
            overrides: { ...context.overrides, [ui]: !uiEnabled },
          });
          expect({ ...actual, [ui]: undefined }).toEqual({
            ...withoutUi,
            [ui]: undefined,
          });
        }
      }
    }
  });
});
