import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { expect, test } from "vitest";
import {
  featureGuidesContract,
  type ImportFeatureGuide,
} from "@okouai/api-contracts/contracts/feature-guides";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { mockOptionalEnv } from "../../../lib/env";
import { featureGuidesRoutes } from "../feature-guides";
import { featureSwitchesRoutes } from "../feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const STAFF_ORG = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const NOW = Date.parse("2026-10-28T00:00:00.000Z");

function clients() {
  const client = setupApp({
    context,
    routes: [...featureGuidesRoutes, ...featureSwitchesRoutes],
  });
  return {
    guide: client(featureGuidesContract),
    switches: client(featureSwitchesContract),
  };
}

async function identity(
  orgId = `org_${randomUUID()}`,
  userId = `user_${randomUUID()}`,
) {
  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  mocks.clerk.session(userId, orgId);
  return { orgId, userId };
}
function signIn(owner: { orgId: string; userId: string }) {
  mocks.clerk.session(owner.userId, owner.orgId);
}
async function setSingleAgentEnabled(value: boolean) {
  await accept(
    clients().switches.update({
      headers,
      body: { switches: { [FeatureSwitchKey.SingleAgent]: value } },
    }),
    [200],
  );
}
function draft(
  overrides: Partial<ImportFeatureGuide> = {},
): ImportFeatureGuide {
  return {
    editionId: `guide-${randomUUID()}`,
    startsAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    content: {
      schemaVersion: 1,
      title: "This month's new ways to work",
      description: "A short product update",
      items: [
        {
          featureId: "report",
          title: "Prepare a report",
          description: "Get from notes to a useful summary",
          prompt: "Prepare a report from my notes",
        },
      ],
    },
    ...overrides,
  };
}
async function prepare(input = draft()) {
  const staff = await identity(STAFF_ORG);
  const imported = await accept(
    clients().guide.import({ headers, body: input }),
    [200],
  );
  return { staff, input, ...imported.body };
}
async function publish(prepared: Awaited<ReturnType<typeof prepare>>) {
  signIn(prepared.staff);
  await accept(
    clients().guide.publish({
      headers,
      params: { editionId: prepared.editionId },
      body: { revisionId: prepared.revisionId },
    }),
    [200],
  );
}
async function current() {
  return (await accept(clients().guide.current({ headers }), [200])).body
    .edition;
}

test("delivers published guides to eligible members", async () => {
  await setupApp({
    context,
    routes: [...featureGuidesRoutes, ...featureSwitchesRoutes],
    isolatePg: true,
  });
  mockNow(NOW);
  const viewer = await identity();
  const prepared = await prepare(
    draft({
      audience: { users: [viewer] },
      content: {
        schemaVersion: 1,
        title: "Product update",
        description: "Explore the latest capabilities",
        items: (
          ["connect-discord", "open-artifacts", "open-chats"] as const
        ).map((type) => {
          return {
            featureId: type,
            title: "Explore an update",
            description: "A new way to work",
            media: {
              type: "image",
              url: "https://example.com/guide.png",
              alt: "A feature illustration",
            },
            action: { type, label: "Open feature" },
          };
        }),
      },
    }),
  );
  signIn(viewer);
  await expect(current()).resolves.toBeNull();
  await publish(prepared);
  signIn(viewer);
  await expect(current()).resolves.toMatchObject({
    id: prepared.editionId,
    revisionId: prepared.revisionId,
    content: prepared.input.content,
  });
});

test("filters bound items by effective switches and leaves empty bindings unrestricted", async () => {
  const viewer = await identity();
  const peer = await identity(viewer.orgId);
  const input = draft({ audience: { users: [viewer, peer] } });
  const prepared = await prepare({
    ...input,
    content: {
      ...input.content,
      items: input.content.items.flatMap((item) => {
        return [
          { ...item, featureId: "unbound" },
          { ...item, featureId: "null", featureSwitch: null },
          { ...item, featureId: "empty", featureSwitch: "" },
          {
            ...item,
            featureId: "projects",
            featureSwitch: FeatureSwitchKey.SingleAgent,
          },
          {
            ...item,
            featureId: "unavailable",
            featureSwitch: "unavailable-switch",
          },
        ];
      }),
    },
  });
  await publish(prepared);
  signIn(viewer);
  // My Okou is available by default; a retained member can keep it disabled.
  await expect(current()).resolves.toMatchObject({
    content: { items: prepared.input.content.items.slice(0, 4) },
  });

  signIn(peer);
  await setSingleAgentEnabled(false);
  await expect(current()).resolves.toMatchObject({
    content: { items: prepared.input.content.items.slice(0, 3) },
  });
  await setSingleAgentEnabled(true);
  await expect(current()).resolves.toMatchObject({
    content: { items: prepared.input.content.items.slice(0, 4) },
  });
  await setSingleAgentEnabled(false);
  await expect(current()).resolves.toMatchObject({
    content: { items: prepared.input.content.items.slice(0, 3) },
  });
});

test("suppresses an entirely gated edition without revealing a backlog or consuming its receipt", async () => {
  mockNow(NOW);
  const viewer = await identity();
  const older = await prepare(draft({ audience: { users: [viewer] } }));
  await publish(older);
  mockNow(NOW + 1000);
  const input = draft({ audience: { users: [viewer] } });
  const prepared = await prepare({
    ...input,
    content: {
      ...input.content,
      items: input.content.items.map((item) => {
        return { ...item, featureSwitch: FeatureSwitchKey.SingleAgent };
      }),
    },
  });
  await publish(prepared);
  signIn(viewer);
  await setSingleAgentEnabled(false);
  await expect(current()).resolves.toBeNull();
  mockOptionalEnv("ENV", "preview");
  const preview = await accept(
    clients().guide.current({ headers, query: { preview: "1" } }),
    [200],
  );
  expect(preview.body.edition).toBeNull();
  await setSingleAgentEnabled(true);
  await expect(current()).resolves.toMatchObject({
    id: prepared.editionId,
    content: prepared.input.content,
  });
  await accept(
    clients().guide.seen({
      headers,
      params: { editionId: prepared.editionId },
      body: { revisionId: prepared.revisionId },
    }),
    [200],
  );
  await setSingleAgentEnabled(false);
  await expect(current()).resolves.toBeNull();
  await setSingleAgentEnabled(true);
  await expect(current()).resolves.toBeNull();
});

test("persists seen status per user and edition across workspaces and content revisions", async () => {
  mockNow(NOW);
  const viewer = await identity();
  const peer = await identity(viewer.orgId);
  const otherOrgId = `org_${randomUUID()}`;
  const prepared = await prepare(
    draft({
      audience: {
        users: [viewer, peer, { orgId: otherOrgId, userId: viewer.userId }],
      },
    }),
  );
  await publish(prepared);
  signIn(viewer);
  await expect(current()).resolves.not.toBeNull();
  await accept(
    clients().guide.seen({
      headers,
      params: { editionId: prepared.editionId },
      body: { revisionId: prepared.revisionId },
    }),
    [200],
  );
  await expect(current()).resolves.toBeNull();
  await identity(otherOrgId, viewer.userId);
  await expect(current()).resolves.toBeNull();
  signIn(peer);
  await expect(current()).resolves.not.toBeNull();
  signIn(prepared.staff);
  const changed = await accept(
    clients().guide.import({
      headers,
      body: {
        ...prepared.input,
        content: { ...prepared.input.content, title: "A corrected title" },
      },
    }),
    [200],
  );
  await accept(
    clients().guide.publish({
      headers,
      params: { editionId: prepared.editionId },
      body: { revisionId: changed.body.revisionId },
    }),
    [200],
  );
  signIn(viewer);
  await expect(current()).resolves.toBeNull();
  signIn(peer);
  await expect(current()).resolves.toMatchObject({
    content: { title: "A corrected title" },
  });
});

test("delivers an organization audience to its members without exposing the audience", async () => {
  const viewer = await identity();
  const otherOrg = await identity();
  const prepared = await prepare(
    draft({ audience: { orgIds: [viewer.orgId, otherOrg.orgId] } }),
  );
  await publish(prepared);
  signIn(viewer);
  await expect(current()).resolves.toStrictEqual({
    id: prepared.editionId,
    revisionId: prepared.revisionId,
    content: prepared.input.content,
  });
  await identity(viewer.orgId);
  await expect(current()).resolves.toMatchObject({ id: prepared.editionId });
  signIn(otherOrg);
  await expect(current()).resolves.toMatchObject({ id: prepared.editionId });
  await identity();
  await expect(current()).resolves.toBeNull();
  mockOptionalEnv("ENV", "preview");
  const preview = await accept(
    clients().guide.current({ headers, query: { preview: "1" } }),
    [200],
  );
  expect(preview.body.edition).toBeNull();
  await accept(
    clients().guide.seen({
      headers,
      params: { editionId: prepared.editionId },
      body: { revisionId: prepared.revisionId },
    }),
    [404],
  );
});

test("matches targeted users by organization and user together and unions organization targets", async () => {
  const viewer = await identity();
  const otherUser = await identity();
  const wholeOrg = await identity();
  const prepared = await prepare(
    draft({
      audience: {
        orgIds: [wholeOrg.orgId],
        users: [viewer, otherUser],
      },
    }),
  );
  await publish(prepared);
  await identity(viewer.orgId);
  await expect(current()).resolves.toBeNull();
  await identity(otherUser.orgId, viewer.userId);
  await expect(current()).resolves.toBeNull();
  await accept(
    clients().guide.seen({
      headers,
      params: { editionId: prepared.editionId },
      body: { revisionId: prepared.revisionId },
    }),
    [404],
  );
  signIn(otherUser);
  await expect(current()).resolves.toMatchObject({ id: prepared.editionId });
  await identity(wholeOrg.orgId);
  await expect(current()).resolves.toMatchObject({ id: prepared.editionId });
  signIn(viewer);
  await expect(current()).resolves.toMatchObject({ id: prepared.editionId });
  await accept(
    clients().guide.seen({
      headers,
      params: { editionId: prepared.editionId },
      body: { revisionId: prepared.revisionId },
    }),
    [200],
  );
  await expect(current()).resolves.toBeNull();
  mockOptionalEnv("ENV", "preview");
  const preview = await accept(
    clients().guide.current({ headers, query: { preview: "1" } }),
    [200],
  );
  expect(preview.body).toStrictEqual({
    edition: {
      id: prepared.editionId,
      revisionId: prepared.revisionId,
      content: prepared.input.content,
    },
    preview: true,
  });
  await expect(current()).resolves.toBeNull();
});

test("selects the latest eligible edition per audience without resurfacing seen backlogs", async () => {
  await setupApp({
    context,
    routes: [...featureGuidesRoutes, ...featureSwitchesRoutes],
    isolatePg: true,
  });
  mockNow(NOW);
  const global = await prepare();
  await publish(global);
  const firstViewer = await identity();
  const secondViewer = await identity();
  mockNow(NOW + 1000);
  const first = await prepare(draft({ audience: { users: [firstViewer] } }));
  await publish(first);
  mockNow(NOW + 2000);
  const second = await prepare(
    draft({ audience: { orgIds: [secondViewer.orgId] } }),
  );
  await publish(second);
  signIn(firstViewer);
  await expect(current()).resolves.toMatchObject({ id: first.editionId });
  await accept(
    clients().guide.seen({
      headers,
      params: { editionId: first.editionId },
      body: { revisionId: first.revisionId },
    }),
    [200],
  );
  await expect(current()).resolves.toBeNull();
  signIn(secondViewer);
  await expect(current()).resolves.toMatchObject({ id: second.editionId });
  await identity();
  await expect(current()).resolves.toMatchObject({ id: global.editionId });
});

test("publishes audience changes only through a new immutable revision and preserves seen receipts", async () => {
  const viewer = await identity();
  const prepared = await prepare(draft({ audience: { users: [viewer] } }));
  await publish(prepared);
  const repeated = await accept(
    clients().guide.import({ headers, body: prepared.input }),
    [200],
  );
  expect(repeated.body.revisionId).toBe(prepared.revisionId);
  const changed = await accept(
    clients().guide.import({
      headers,
      body: { ...prepared.input, audience: { orgIds: [viewer.orgId] } },
    }),
    [200],
  );
  expect(changed.body.revisionId).not.toBe(prepared.revisionId);
  const peer = await identity(viewer.orgId);
  await expect(current()).resolves.toBeNull();
  signIn(viewer);
  await accept(
    clients().guide.seen({
      headers,
      params: { editionId: prepared.editionId },
      body: { revisionId: prepared.revisionId },
    }),
    [200],
  );
  await publish({ ...prepared, revisionId: changed.body.revisionId });
  signIn(viewer);
  await expect(current()).resolves.toBeNull();
  signIn(peer);
  await expect(current()).resolves.toMatchObject({
    id: prepared.editionId,
    revisionId: changed.body.revisionId,
  });
});

test.each([
  { name: "null", audience: null },
  { name: "unscoped user", audience: { users: [{ userId: "user_target" }] } },
])(
  "rejects a $name audience instead of broadening delivery",
  async ({ audience }) => {
    await identity(STAFF_ORG);
    const request = setupRawAppRequest({
      context,
      routes: featureGuidesRoutes,
    });
    const response = await request("/api/internal/feature-guides", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ ...draft(), audience }),
    });
    expect(response.status).toBe(400);
  },
);

test("a seen edition does not reveal an older backlog and a new edition can appear", async () => {
  mockNow(NOW);
  const viewer = await identity();
  const older = await prepare(draft({ audience: { users: [viewer] } }));
  await publish(older);
  mockNow(NOW + 1000);
  const newer = await prepare(draft({ audience: { users: [viewer] } }));
  await publish(newer);
  signIn(viewer);
  await expect(current()).resolves.toMatchObject({ id: newer.editionId });
  await accept(
    clients().guide.seen({
      headers,
      params: { editionId: newer.editionId },
      body: { revisionId: newer.revisionId },
    }),
    [200],
  );
  await expect(current()).resolves.toBeNull();
  mockNow(NOW + 2000);
  const next = await prepare(draft({ audience: { users: [viewer] } }));
  await publish(next);
  signIn(viewer);
  await expect(current()).resolves.toMatchObject({ id: next.editionId });
});

test("keeps drafts immutable and publishes only the selected revision", async () => {
  const viewer = await identity();
  const prepared = await prepare(draft({ audience: { users: [viewer] } }));
  const repeated = await accept(
    clients().guide.import({ headers, body: prepared.input }),
    [200],
  );
  expect(repeated.body).toStrictEqual({
    editionId: prepared.editionId,
    revisionId: prepared.revisionId,
  });
  const changed = await accept(
    clients().guide.import({
      headers,
      body: {
        ...prepared.input,
        content: {
          ...prepared.input.content,
          items: prepared.input.content.items.map((item) => {
            return { ...item, featureSwitch: FeatureSwitchKey.SingleAgent };
          }),
        },
      },
    }),
    [200],
  );
  expect(changed.body.revisionId).not.toBe(prepared.revisionId);
  await publish(prepared);
  signIn(viewer);
  await expect(current()).resolves.toMatchObject({
    revisionId: prepared.revisionId,
    content: prepared.input.content,
  });
  signIn(prepared.staff);
  await accept(
    clients().guide.publish({
      headers,
      params: { editionId: prepared.editionId },
      body: { revisionId: null },
    }),
    [200],
  );
  signIn(viewer);
  await expect(current()).resolves.toBeNull();
});

test("respects scheduled and expired publication windows for targeted editions", async () => {
  mockNow(NOW);
  const viewer = await identity();
  const prepared = await prepare(
    draft({
      audience: { users: [viewer] },
      startsAt: new Date(NOW + 1000).toISOString(),
      expiresAt: new Date(NOW + 2000).toISOString(),
    }),
  );
  await publish(prepared);
  signIn(viewer);
  await expect(current()).resolves.toBeNull();
  mockNow(NOW + 1000);
  await expect(current()).resolves.toMatchObject({ id: prepared.editionId });
  mockNow(NOW + 2000);
  await expect(current()).resolves.toBeNull();
});

test("requires hard staff authorization for importing and publishing", async () => {
  const viewer = await identity();
  const imported = await accept(
    clients().guide.import({
      headers,
      body: draft({ audience: { users: [viewer] } }),
    }),
    [403],
  );
  expect(imported.status).toBe(403);
  const published = await accept(
    clients().guide.publish({
      headers,
      params: { editionId: "unknown-edition" },
      body: { revisionId: null },
    }),
    [403],
  );
  expect(published.status).toBe(403);
});

test("does not mark an unpublished revision as seen", async () => {
  const prepared = await prepare();
  await identity();
  const rejected = await accept(
    clients().guide.seen({
      headers,
      params: { editionId: prepared.editionId },
      body: { revisionId: prepared.revisionId },
    }),
    [404],
  );
  expect(rejected.status).toBe(404);
});

test("requires a session and validates content, audiences and publication windows", async () => {
  const signedOut = await accept(
    clients().guide.current({ headers: {} }),
    [401],
  );
  expect(signedOut.status).toBe(401);
  await identity(STAFF_ORG);
  const input = draft();
  await accept(
    clients().guide.import({
      headers,
      body: { ...input, audience: {} },
    }),
    [400],
  );
  await accept(
    clients().guide.import({
      headers,
      body: {
        ...input,
        startsAt: "2026-02-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:00:00.000Z",
      },
    }),
    [400],
  );
  await accept(
    clients().guide.import({
      headers,
      body: {
        ...input,
        content: {
          ...input.content,
          items: [
            {
              featureId: "unsafe",
              title: "Unsafe",
              description: "Unsafe media",
              media: {
                type: "image",
                url: "javascript:alert(1)",
                alt: "Unsafe",
              },
            },
          ],
        },
      },
    }),
    [400],
  );
});

test("rejects guide replay in production deployments", async () => {
  await identity();
  mockOptionalEnv("ENV", "production");
  const rejected = await accept(
    clients().guide.current({ headers, query: { preview: "1" } }),
    [403],
  );
  expect(rejected.status).toBe(403);
});

test("previews the illustrated My Okou guide without publishing or acknowledging an edition", async () => {
  mockOptionalEnv("ENV", "preview");
  await identity();
  const query = { preview: "1", edition: "single-agent-2026-11-16" } as const;
  const preview = await accept(
    clients().guide.current({ headers, query }),
    [200],
  );
  expect(preview.body).toMatchObject({
    preview: true,
    edition: {
      id: query.edition,
      content: {
        items: [
          {
            title: "One Okou. Your subagents, now projects",
            media: {
              type: "illustration",
              characterUrl: expect.stringMatching(/^https:\/\//u),
              scene: { type: "projects" },
            },
          },
          {
            title: "Your instructions are now in Settings",
            media: {
              type: "illustration",
              scene: {
                type: "instructions",
                location: ["Settings", "Personal", "My Okou"],
              },
            },
          },
          {
            title: "Your workflows, in one place",
            media: { type: "illustration", scene: { type: "workflows" } },
          },
        ],
      },
    },
  });
  const revisionId = preview.body.edition?.revisionId;
  if (!revisionId) {
    throw new Error("Expected a preview revision");
  }
  await accept(
    clients().guide.seen({
      headers,
      params: { editionId: query.edition },
      body: { revisionId },
    }),
    [404],
  );
  mockOptionalEnv("ENV", "production");
  await accept(clients().guide.current({ headers, query }), [403]);
});
