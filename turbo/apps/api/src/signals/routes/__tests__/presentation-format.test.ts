import { randomUUID } from "node:crypto";

import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { presentationFormatContract } from "@okouai/api-contracts/contracts/presentation-format";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { featureSwitchesRoutes } from "../feature-switches";
import { presentationFormatRoutes } from "../presentation-format";
import { userPreferencesRoutes } from "../user-preferences";
import { createRouteMocks } from "./helpers/route-test";
import { createRunExecutionCredentials } from "./helpers/run-execution-credentials";

const context = testContext();
const mocks = createRouteMocks(context);
const credentials = createRunExecutionCredentials(context);
const sessionHeaders = Object.freeze({ authorization: "Bearer clerk-session" });
const key = FeatureSwitchKey.PresentationOutputFormat;
const eligibleUserId = "user_3EWY21Oe3f15kfs3yYmbGgDb3NV";

function clients() {
  const app = setupApp({
    context,
    routes: [
      ...presentationFormatRoutes,
      ...userPreferencesRoutes,
      ...featureSwitchesRoutes,
    ],
  });
  return {
    format: app(presentationFormatContract),
    preferences: app(userPreferencesContract),
    switches: app(featureSwitchesContract),
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("GET /api/presentation-format", () => {
  it("reads only the token-scoped preference without writing defaults, isolates members and workspaces, and honors current opt-out", async () => {
    const owner = {
      userId: eligibleUserId,
      orgId: createUniqueStaffOrgIdFixture(),
    };
    const peer = { userId: `user_${randomUUID()}`, orgId: owner.orgId };
    const otherWorkspace = {
      userId: owner.userId,
      orgId: `org_${randomUUID()}`,
    };
    const { format, preferences, switches } = clients();
    const execution = await credentials.forActor(owner);
    const ownerHeaders = bearer(execution.token);

    mocks.clerk.session(owner.userId, owner.orgId);
    const enabled = await accept(
      switches.get({ headers: sessionHeaders }),
      [200],
    );
    expect(enabled.body.effectiveSwitches).toHaveProperty(key, true);
    const beforeRead = await accept(
      preferences.get({ headers: sessionHeaders }),
      [200],
    );
    expect(beforeRead.body.presentationFormat).toBeNull();

    const initial = await accept(format.get({ headers: ownerHeaders }), [200]);
    expect(initial.body).toStrictEqual({ presentationFormat: null });
    expect(initial.headers.get("cache-control")).toBe("no-store");
    const afterRead = await accept(
      preferences.get({ headers: sessionHeaders }),
      [200],
    );
    expect(afterRead.body).toStrictEqual(beforeRead.body);

    await accept(format.get({ headers: {} }), [401]);
    const sessionDenied = await accept(
      format.get({ headers: sessionHeaders }),
      [403],
    );
    expect(sessionDenied.body.error.code).toBe("FORBIDDEN");
    const sandboxDenied = await accept(
      format.get({ headers: bearer(execution.sandboxToken) }),
      [403],
    );
    expect(sandboxDenied.body.error.code).toBe("FORBIDDEN");

    await accept(
      preferences.update({
        headers: sessionHeaders,
        body: { presentationFormat: "pptx" },
      }),
      [200],
    );
    const pptx = await accept(format.get({ headers: ownerHeaders }), [200]);
    expect(pptx.body).toStrictEqual({ presentationFormat: "pptx" });

    // Each additional identity gets one genuine execution, reused for all reads.
    const peerExecution = await credentials.forActor(peer);
    const peerInitial = await accept(
      format.get({ headers: bearer(peerExecution.token) }),
      [200],
    );
    expect(peerInitial.body).toStrictEqual({ presentationFormat: null });
    mocks.clerk.session(peer.userId, peer.orgId);
    await accept(
      preferences.update({
        headers: sessionHeaders,
        body: { presentationFormat: "html" },
      }),
      [200],
    );

    const workspaceExecution = await credentials.forActor(otherWorkspace);
    const workspaceInitial = await accept(
      format.get({ headers: bearer(workspaceExecution.token) }),
      [200],
    );
    expect(workspaceInitial.body).toStrictEqual({ presentationFormat: null });

    // Deliberately leave an unrelated session selected: the token owns the scope.
    mocks.clerk.session(otherWorkspace.userId, otherWorkspace.orgId);
    expect(
      (await accept(format.get({ headers: ownerHeaders }), [200])).body,
    ).toStrictEqual({ presentationFormat: "pptx" });
    mocks.clerk.session(owner.userId, owner.orgId);
    expect(
      (
        await accept(
          format.get({ headers: bearer(peerExecution.token) }),
          [200],
        )
      ).body,
    ).toStrictEqual({ presentationFormat: "html" });
    expect(
      (
        await accept(
          format.get({ headers: bearer(workspaceExecution.token) }),
          [200],
        )
      ).body,
    ).toStrictEqual({ presentationFormat: null });

    const htmlSaved = await accept(
      preferences.update({
        headers: sessionHeaders,
        body: { presentationFormat: "html" },
      }),
      [200],
    );
    const html = await accept(format.get({ headers: ownerHeaders }), [200]);
    expect(html.body).toStrictEqual({ presentationFormat: "html" });
    const afterHtmlRead = await accept(
      preferences.get({ headers: sessionHeaders }),
      [200],
    );
    expect(afterHtmlRead.body).toStrictEqual(htmlSaved.body);

    await expect(
      preferences.update({
        headers: ownerHeaders,
        body: { presentationFormat: "pptx" },
      }),
    ).rejects.toThrow(
      "Unknown response status 403 for POST /api/user-preferences",
    );
    const afterDeniedWrite = await accept(
      preferences.get({ headers: sessionHeaders }),
      [200],
    );
    expect(afterDeniedWrite.body).toStrictEqual(htmlSaved.body);

    const disabled = await accept(
      switches.update({
        headers: sessionHeaders,
        body: { switches: { [key]: false } },
      }),
      [200],
    );
    expect(disabled.body.effectiveSwitches).toHaveProperty(key, false);
    const revoked = await accept(format.get({ headers: ownerHeaders }), [403]);
    expect(revoked.body.error).toStrictEqual({
      code: "FORBIDDEN",
      message: "Presentation output format is disabled",
    });

    const disabledExecution = await credentials.freshForActor(owner);
    const disabledHeaders = bearer(disabledExecution.token);
    const missingCapability = await accept(
      format.get({ headers: disabledHeaders }),
      [403],
    );
    expect(missingCapability.body.error).toStrictEqual({
      code: "FORBIDDEN",
      message: "Missing required capability: presentation-format:read",
    });

    mocks.clerk.session(owner.userId, owner.orgId);
    const reenabled = await accept(
      switches.update({
        headers: sessionHeaders,
        body: { switches: { [key]: true } },
      }),
      [200],
    );
    expect(reenabled.body.effectiveSwitches).toHaveProperty(key, true);
    // Re-enabling a flag cannot add a capability to an already issued token.
    const stillMissing = await accept(
      format.get({ headers: disabledHeaders }),
      [403],
    );
    expect(stillMissing.body.error).toStrictEqual(missingCapability.body.error);
    const restored = await accept(format.get({ headers: ownerHeaders }), [200]);
    expect(restored.body).toStrictEqual({ presentationFormat: "html" });
  });

  it("does not issue the read capability to an out-of-audience admin with a true override", async () => {
    const outsider = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    const { format, switches } = clients();
    mocks.clerk.session(outsider.userId, outsider.orgId, "org:admin");
    const optedIn = await accept(
      switches.update({
        headers: sessionHeaders,
        body: { switches: { [key]: true } },
      }),
      [200],
    );
    expect(optedIn.body.switches).toHaveProperty(key, true);
    expect(optedIn.body.effectiveSwitches).toHaveProperty(key, false);

    const execution = await credentials.forActor(outsider);
    const denied = await accept(
      format.get({ headers: bearer(execution.token) }),
      [403],
    );
    expect(denied.body.error).toStrictEqual({
      code: "FORBIDDEN",
      message: "Missing required capability: presentation-format:read",
    });
    mocks.clerk.session(outsider.userId, outsider.orgId, "org:admin");
    const retained = await accept(
      switches.get({ headers: sessionHeaders }),
      [200],
    );
    expect(retained.body.switches).toHaveProperty(key, true);
    expect(retained.body.effectiveSwitches).toHaveProperty(key, false);
  });
});
