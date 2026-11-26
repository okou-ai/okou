import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { randomInt, randomUUID } from "node:crypto";
import {
  featureGuidesContract,
  type FeatureGuideContent,
  type ImportFeatureGuide,
} from "@okouai/api-contracts/contracts/feature-guides";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { testContext, accept } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { featureGuidesRoutes } from "../feature-guides";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const BASE = Date.parse("2026-10-28T00:00:00Z");

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

function actor(orgId = `org_${randomUUID()}`): Actor {
  return { userId: `user_${randomUUID()}`, orgId };
}

function signIn(who: Actor) {
  createRouteMocks(context).clerk.session(who.userId, who.orgId, "org:member");
}

function guides() {
  return setupApp({ context, routes: featureGuidesRoutes })(
    featureGuidesContract,
  );
}

function content(
  title = "What's new",
  items: FeatureGuideContent["items"] = [
    {
      featureId: "discord",
      title: "Chat from Discord",
      description: "Connect Discord to talk to your agent.",
      media: {
        type: "image",
        url: "https://cdn.okou.test/discord.png",
        alt: "Discord",
      },
      action: { type: "connect-discord", label: "Connect Discord" },
    },
    {
      featureId: "artifacts",
      title: "Artifacts",
      description: "Browse everything your agent made.",
      media: {
        type: "image",
        url: "https://cdn.okou.test/artifacts.png",
        alt: "Artifacts",
      },
      action: { type: "open-artifacts", label: "Open artifacts" },
    },
    {
      featureId: "chats",
      title: "Chats",
      description: "Pick up any conversation.",
      media: {
        type: "image",
        url: "https://cdn.okou.test/chats.png",
        alt: "Chats",
      },
      action: { type: "open-chats", label: "Open chats" },
    },
  ],
): FeatureGuideContent {
  return {
    schemaVersion: 1,
    title,
    description: "Fresh features for your workspace.",
    items,
  };
}

function editionId() {
  return `guide-${randomUUID()}`;
}

const staff = actor(createUniqueStaffOrgIdFixture());

async function importGuide(input: ImportFeatureGuide) {
  signIn(staff);
  const response = await accept(
    guides().import({ headers, body: input }),
    [200],
  );
  return response.body;
}

async function publish(id: string, revisionId: string | null) {
  signIn(staff);
  await accept(
    guides().publish({
      headers,
      params: { editionId: id },
      body: { revisionId },
    }),
    [200],
  );
}

/** Staff imports and publishes an edition at the current clock. */
async function published(
  input: Omit<ImportFeatureGuide, "startsAt" | "expiresAt"> & {
    readonly startsAt?: string;
    readonly expiresAt?: string | null;
  },
) {
  const imported = await importGuide({
    startsAt: new Date(BASE).toISOString(),
    expiresAt: null,
    ...input,
  });
  await publish(imported.editionId, imported.revisionId);
  return imported;
}

async function current(who: Actor, preview = false) {
  signIn(who);
  const response = await accept(
    guides().current({
      headers,
      query: preview ? { preview: "1" } : undefined,
    }),
    [200],
  );
  return response.body;
}

async function currentEdition(who: Actor) {
  return (await current(who)).edition;
}

async function markSeen(
  who: Actor,
  id: string,
  revisionId: string,
  status: 200 | 404 = 200,
) {
  signIn(who);
  await accept(
    guides().seen({ headers, params: { editionId: id }, body: { revisionId } }),
    [status],
  );
}

function featureIds(edition: { content: FeatureGuideContent } | null) {
  return (edition?.content.items ?? []).map((item) => {
    return item.featureId;
  });
}

describe("feature guides", () => {
  it("feature-guides-014 requires hard staff authorization for importing and publishing", async () => {
    const member = actor();
    signIn(member);

    const [imported, publishedEdition] = await Promise.all([
      guides().import({
        headers,
        body: {
          editionId: editionId(),
          content: content(),
          startsAt: new Date(BASE).toISOString(),
          expiresAt: null,
        },
      }),
      guides().publish({
        headers,
        params: { editionId: editionId() },
        body: { revisionId: randomUUID() },
      }),
    ]);

    expect([imported.status, publishedEdition.status]).toStrictEqual([
      403, 403,
    ]);
  });

  it("feature-guides-001 delivers published guides to eligible members", async () => {
    mockNow(new Date(BASE));
    const member = actor();
    const guide = content();
    const imported = await importGuide({
      editionId: editionId(),
      content: guide,
      audience: { users: [{ orgId: member.orgId, userId: member.userId }] },
      startsAt: new Date(BASE).toISOString(),
      expiresAt: null,
    });

    await expect(currentEdition(member)).resolves.toBeNull();
    await publish(imported.editionId, imported.revisionId);

    await expect(currentEdition(member)).resolves.toStrictEqual({
      id: imported.editionId,
      revisionId: imported.revisionId,
      content: guide,
    });
  });

  it("feature-guides-002 filters bound items by effective switches and leaves empty bindings unrestricted", async () => {
    mockNow(new Date(BASE));
    const first = actor();
    const peer = actor(first.orgId);
    const item = (featureId: string, featureSwitch: string | null) => {
      return {
        featureId,
        featureSwitch,
        title: `Feature ${featureId}`,
        description: "A bound feature.",
      };
    };
    await published({
      editionId: editionId(),
      content: content("Switch bound", [
        item("unbound", null),
        item("empty", ""),
        item("single-agent", "singleAgent"),
        item("dummy", FeatureSwitchKey.Dummy),
        item("unknown", "unknownFeatureSwitch"),
      ]),
      audience: {
        users: [
          { orgId: first.orgId, userId: first.userId },
          { orgId: peer.orgId, userId: peer.userId },
        ],
      },
    });
    const all = ["unbound", "empty", "single-agent", "dummy"];
    const withoutDummy = ["unbound", "empty", "single-agent"];

    expect(featureIds(await currentEdition(first))).toStrictEqual(all);
    const seenByPeer = [];
    for (const enabled of [false, true, false]) {
      await updateFeatureSwitchesForUser(context, peer, {
        [FeatureSwitchKey.Dummy]: enabled,
      });
      seenByPeer.push(featureIds(await currentEdition(peer)));
    }
    expect(seenByPeer).toStrictEqual([withoutDummy, all, withoutDummy]);
  });

  it("feature-guides-004 persists seen status per user and edition across workspaces and content revisions", async () => {
    mockNow(new Date(BASE));
    const member = actor();
    const peer = actor(member.orgId);
    const memberElsewhere = {
      userId: member.userId,
      orgId: `org_${randomUUID()}`,
    };
    const id = editionId();
    const audience = {
      users: [member, peer, memberElsewhere].map((who) => {
        return { orgId: who.orgId, userId: who.userId };
      }),
    };
    const original = await published({
      editionId: id,
      content: content(),
      audience,
    });

    await expect(currentEdition(member)).resolves.toMatchObject({ id });
    await markSeen(member, id, original.revisionId);
    await expect(currentEdition(member)).resolves.toBeNull();
    await expect(currentEdition(memberElsewhere)).resolves.toBeNull();
    await expect(currentEdition(peer)).resolves.toMatchObject({ id });

    await published({
      editionId: id,
      content: content("Corrected title"),
      audience,
    });
    await expect(currentEdition(member)).resolves.toBeNull();
    const corrected = await currentEdition(peer);
    expect(corrected?.content.title).toBe("Corrected title");
  });

  it("feature-guides-005 delivers an organization audience to its members without exposing the audience", async () => {
    mockNow(new Date(BASE));
    const first = actor();
    const colleague = actor(first.orgId);
    const second = actor();
    const unrelated = actor();
    const guide = content();
    const imported = await published({
      editionId: editionId(),
      content: guide,
      audience: { orgIds: [first.orgId, second.orgId] },
    });

    await expect(current(first)).resolves.toStrictEqual({
      edition: {
        id: imported.editionId,
        revisionId: imported.revisionId,
        content: guide,
      },
    });
    await expect(currentEdition(colleague)).resolves.toMatchObject({
      id: imported.editionId,
    });
    await expect(currentEdition(second)).resolves.toMatchObject({
      id: imported.editionId,
    });
    await expect(currentEdition(unrelated)).resolves.toBeNull();
    mockOptionalEnv("ENV", "preview");
    await expect(current(unrelated, true)).resolves.toMatchObject({
      edition: null,
    });
    await markSeen(unrelated, imported.editionId, imported.revisionId, 404);
  });

  it("feature-guides-006 matches targeted users by organization and user together and unions organization targets", async () => {
    mockNow(new Date(BASE));
    const firstTarget = actor();
    const secondTarget = actor();
    const wholeWorkspaceMember = actor();
    const firstTargetColleague = actor(firstTarget.orgId);
    const firstTargetInSecond = {
      userId: firstTarget.userId,
      orgId: secondTarget.orgId,
    };
    const guide = content();
    const imported = await published({
      editionId: editionId(),
      content: guide,
      audience: {
        orgIds: [wholeWorkspaceMember.orgId],
        users: [firstTarget, secondTarget].map((who) => {
          return { orgId: who.orgId, userId: who.userId };
        }),
      },
    });
    const { editionId: id, revisionId } = imported;

    for (const outsider of [firstTargetColleague, firstTargetInSecond]) {
      await expect(currentEdition(outsider)).resolves.toBeNull();
      await markSeen(outsider, id, revisionId, 404);
    }
    for (const target of [secondTarget, wholeWorkspaceMember, firstTarget]) {
      await expect(currentEdition(target)).resolves.toMatchObject({ id });
    }
    await markSeen(firstTarget, id, revisionId);
    await expect(currentEdition(firstTarget)).resolves.toBeNull();
    mockOptionalEnv("ENV", "preview");
    await expect(current(firstTarget, true)).resolves.toStrictEqual({
      edition: { id, revisionId, content: guide },
      preview: true,
    });
    await expect(currentEdition(firstTarget)).resolves.toBeNull();
  });

  it("feature-guides-007 selects the latest eligible edition per audience without resurfacing seen backlogs", async () => {
    // A private publication window keeps this global edition from reaching other cases.
    const base =
      Date.parse("2031-01-01T00:00:00Z") + randomInt(0, 1_000_000) * 60_000;
    const window = {
      startsAt: new Date(base).toISOString(),
      expiresAt: new Date(base + 60_000).toISOString(),
    };
    const first = actor();
    const second = actor();
    const untargeted = actor();
    mockNow(new Date(base));
    const global = await published({
      editionId: editionId(),
      content: content("Global"),
      ...window,
    });
    mockNow(new Date(base + 1000));
    const forFirst = await published({
      editionId: editionId(),
      content: content("For the first member"),
      audience: { users: [{ orgId: first.orgId, userId: first.userId }] },
      ...window,
    });
    mockNow(new Date(base + 3000));
    const forSecond = await published({
      editionId: editionId(),
      content: content("For the second workspace"),
      audience: { orgIds: [second.orgId] },
      ...window,
    });

    await expect(currentEdition(first)).resolves.toMatchObject({
      id: forFirst.editionId,
    });
    await markSeen(first, forFirst.editionId, forFirst.revisionId);
    await expect(currentEdition(first)).resolves.toBeNull();
    await expect(currentEdition(second)).resolves.toMatchObject({
      id: forSecond.editionId,
    });
    await expect(currentEdition(untargeted)).resolves.toMatchObject({
      id: global.editionId,
    });
  });

  it("feature-guides-012 keeps drafts immutable and publishes only the selected revision", async () => {
    mockNow(new Date(BASE));
    const member = actor();
    const guide = content();
    const input = {
      editionId: editionId(),
      content: guide,
      audience: { users: [{ orgId: member.orgId, userId: member.userId }] },
      startsAt: new Date(BASE).toISOString(),
      expiresAt: null,
    };
    const original = await importGuide(input);
    await expect(importGuide(input)).resolves.toStrictEqual(original);
    const changed = await importGuide({
      ...input,
      content: content(
        guide.title,
        guide.items.map((item) => {
          return { ...item, featureSwitch: FeatureSwitchKey.Dummy };
        }),
      ),
    });
    expect(changed.editionId).toBe(original.editionId);
    expect(changed.revisionId).not.toBe(original.revisionId);

    await publish(original.editionId, original.revisionId);
    await expect(currentEdition(member)).resolves.toStrictEqual({
      id: original.editionId,
      revisionId: original.revisionId,
      content: guide,
    });
    await publish(original.editionId, null);
    await expect(currentEdition(member)).resolves.toBeNull();
  });

  it("feature-guides-013 respects scheduled and expired publication windows for targeted editions", async () => {
    mockNow(new Date(BASE));
    const member = actor();
    const imported = await published({
      editionId: editionId(),
      content: content(),
      audience: { users: [{ orgId: member.orgId, userId: member.userId }] },
      startsAt: new Date(BASE + 1000).toISOString(),
      expiresAt: new Date(BASE + 2000).toISOString(),
    });

    const reads = [];
    for (const at of [BASE, BASE + 1000, BASE + 2000]) {
      mockNow(new Date(at));
      reads.push((await currentEdition(member))?.id ?? null);
    }
    expect(reads).toStrictEqual([null, imported.editionId, null]);
  });
});
