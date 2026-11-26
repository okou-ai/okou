import { randomUUID } from "node:crypto";
import {
  ORG_OPENROUTER_PRESETS,
  orgOpenrouterPresetContract,
  type OrgOpenrouterPreset,
} from "@okouai/api-contracts/contracts/org-openrouter-preset";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { orgOpenrouterPresetRoutes } from "../org-openrouter-preset";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const rawRequest = setupRawAppRequest({
  context,
  routes: orgOpenrouterPresetRoutes,
});
const presets = setupApp({ context, routes: orgOpenrouterPresetRoutes })(
  orgOpenrouterPresetContract,
);

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole: "org:admin" | "org:member";
}

async function debugActor(
  orgId: string,
  orgRole: Actor["orgRole"] = "org:admin",
): Promise<Actor> {
  const actor = { userId: `user_${randomUUID()}`, orgId, orgRole };
  await updateFeatureSwitchesForUser(context, actor, {
    [FeatureSwitchKey.OkouDebug]: true,
  });
  return actor;
}

function as(actor: Actor) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
}

async function readPreset(actor: Actor) {
  as(actor);
  const response = await accept(presets.get({ headers }), [200]);
  return response.body.openrouterPreset;
}

async function savePreset(
  actor: Actor,
  openrouterPreset: OrgOpenrouterPreset | null,
) {
  as(actor);
  await accept(presets.update({ headers, body: { openrouterPreset } }), [200]);
}

test("org-openrouter-preset-001 lets a Debug administrator persist each allowed preset for the organization", async () => {
  const orgId = `org_${randomUUID()}`;
  const admin = await debugActor(orgId);
  const peer = await debugActor(orgId);
  const outsider = await debugActor(`org_${randomUUID()}`);

  const initial = await readPreset(admin);
  const readBack: (string | null)[] = [];
  for (const preset of ORG_OPENROUTER_PRESETS) {
    await savePreset(admin, preset);
    readBack.push(await readPreset(admin));
  }

  expect(initial).toBeNull();
  expect(readBack).toStrictEqual([
    "@preset/okou-1-0",
    "@preset/okou-1-0-dsf",
    "@preset/okou-experimental",
  ]);
  await expect(readPreset(peer)).resolves.toBe("@preset/okou-experimental");
  await expect(readPreset(outsider)).resolves.toBeNull();
});

test("org-openrouter-preset-003 denies preset reads and writes to a Debug-enabled member", async () => {
  const orgId = `org_${randomUUID()}`;
  const admin = await debugActor(orgId);
  await savePreset(admin, "@preset/okou-1-0");
  const member = await debugActor(orgId, "org:member");

  as(member);
  const read = await presets.get({ headers });
  const experimental = await presets.update({
    headers,
    body: { openrouterPreset: "@preset/okou-experimental" },
  });
  const cleared = await presets.update({
    headers,
    body: { openrouterPreset: null },
  });

  expect([read.status, experimental.status, cleared.status]).toStrictEqual([
    403, 403, 403,
  ]);
  await expect(readPreset(admin)).resolves.toBe("@preset/okou-1-0");
});

test("org-openrouter-preset-004 denies preset reads and writes to an administrator without Debug", async () => {
  const orgId = `org_${randomUUID()}`;
  const admin = await debugActor(orgId);
  await savePreset(admin, "@preset/okou-1-0");
  const plainAdmin: Actor = {
    userId: `user_${randomUUID()}`,
    orgId,
    orgRole: "org:admin",
  };
  await updateFeatureSwitchesForUser(context, plainAdmin, {
    [FeatureSwitchKey.OkouDebug]: false,
  });

  as(plainAdmin);
  const read = await presets.get({ headers });
  const experimental = await presets.update({
    headers,
    body: { openrouterPreset: "@preset/okou-experimental" },
  });
  const cleared = await presets.update({
    headers,
    body: { openrouterPreset: null },
  });

  expect([read.status, experimental.status, cleared.status]).toStrictEqual([
    403, 403, 403,
  ]);
  await expect(readPreset(admin)).resolves.toBe("@preset/okou-1-0");
});

test("org-openrouter-preset-005 rejects unlisted presets and caller-selected organizations", async () => {
  const admin = await debugActor(`org_${randomUUID()}`);
  await savePreset(admin, "@preset/okou-1-0");

  as(admin);
  const statuses: number[] = [];
  for (const body of [
    { openrouterPreset: "@preset/not-allowed" },
    { openrouterPreset: "@preset/okou-experimental", orgId: "org_another" },
    { openrouterPreset: null, orgId: "org_another" },
  ]) {
    const response = await rawRequest("/api/org/openrouter-preset", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    statuses.push(response.status);
  }

  expect(statuses).toStrictEqual([400, 400, 400]);
  await expect(readPreset(admin)).resolves.toBe("@preset/okou-1-0");
});
