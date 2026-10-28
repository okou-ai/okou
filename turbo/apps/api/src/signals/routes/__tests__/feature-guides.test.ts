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
import { setupApp } from "../../../__tests__/test-helpers";
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
async function enable(value = true) {
  await accept(
    clients().switches.update({
      headers,
      body: { switches: { [FeatureSwitchKey.FeatureGuides]: value } },
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

test("only delivers a published edition when its server-side feature switch is enabled", async () => {
  await setupApp({
    context,
    routes: [...featureGuidesRoutes, ...featureSwitchesRoutes],
    isolatePg: true,
  });
  mockNow(NOW);
  const prepared = await prepare();
  const viewer = await identity();
  await enable();
  await expect(current()).resolves.toBeNull();
  await publish(prepared);
  signIn(viewer);
  await enable(false);
  await expect(current()).resolves.toBeNull();
  await enable();
  await expect(current()).resolves.toMatchObject({
    id: prepared.editionId,
    revisionId: prepared.revisionId,
    content: prepared.input.content,
  });
  await enable(false);
  await expect(current()).resolves.toBeNull();
  await accept(
    clients().guide.seen({
      headers,
      params: { editionId: prepared.editionId },
      body: { revisionId: prepared.revisionId },
    }),
    [403],
  );
});

test("persists seen status per user and edition across workspaces and content revisions", async () => {
  await setupApp({
    context,
    routes: [...featureGuidesRoutes, ...featureSwitchesRoutes],
    isolatePg: true,
  });
  mockNow(NOW);
  const prepared = await prepare();
  await publish(prepared);
  const viewer = await identity();
  await enable();
  await expect(current()).resolves.not.toBeNull();
  await Promise.all(
    [0, 1].map(async () => {
      await accept(
        clients().guide.seen({
          headers,
          params: { editionId: prepared.editionId },
          body: { revisionId: prepared.revisionId },
        }),
        [200],
      );
    }),
  );
  await expect(current()).resolves.toBeNull();
  await identity(`org_${randomUUID()}`, viewer.userId);
  await enable();
  await expect(current()).resolves.toBeNull();
  const peer = await identity(viewer.orgId);
  await enable();
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

test("a seen edition does not reveal an older backlog and a new edition can appear", async () => {
  await setupApp({
    context,
    routes: [...featureGuidesRoutes, ...featureSwitchesRoutes],
    isolatePg: true,
  });
  mockNow(NOW);
  const older = await prepare();
  await publish(older);
  mockNow(NOW + 1000);
  const newer = await prepare();
  await publish(newer);
  mockNow(NOW + 1500);
  await publish(older);
  const viewer = await identity();
  await enable();
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
  const next = await prepare();
  await publish(next);
  signIn(viewer);
  await expect(current()).resolves.toMatchObject({ id: next.editionId });
});

test("keeps drafts immutable and publishes only the selected revision", async () => {
  await setupApp({
    context,
    routes: [...featureGuidesRoutes, ...featureSwitchesRoutes],
    isolatePg: true,
  });
  const prepared = await prepare();
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
        content: { ...prepared.input.content, title: "A later draft" },
      },
    }),
    [200],
  );
  expect(changed.body.revisionId).not.toBe(prepared.revisionId);
  await publish(prepared);
  await identity();
  await enable();
  await expect(current()).resolves.toMatchObject({
    revisionId: prepared.revisionId,
    content: { title: prepared.input.content.title },
  });
  signIn(prepared.staff);
  await accept(
    clients().guide.publish({
      headers,
      params: { editionId: prepared.editionId },
      body: { revisionId: randomUUID() },
    }),
    [404],
  );
  await accept(
    clients().guide.publish({
      headers,
      params: { editionId: prepared.editionId },
      body: { revisionId: null },
    }),
    [200],
  );
  await expect(current()).resolves.toBeNull();
});

test("respects scheduled and expired publication windows", async () => {
  await setupApp({
    context,
    routes: [...featureGuidesRoutes, ...featureSwitchesRoutes],
    isolatePg: true,
  });
  mockNow(NOW);
  const prepared = await prepare(
    draft({
      startsAt: new Date(NOW + 1000).toISOString(),
      expiresAt: new Date(NOW + 2000).toISOString(),
    }),
  );
  await publish(prepared);
  await identity();
  await enable();
  await expect(current()).resolves.toBeNull();
  mockNow(NOW + 1000);
  await expect(current()).resolves.toMatchObject({ id: prepared.editionId });
  mockNow(NOW + 2000);
  await expect(current()).resolves.toBeNull();
});

test("requires hard staff authorization for importing and publishing, even after opting in", async () => {
  await setupApp({
    context,
    routes: [...featureGuidesRoutes, ...featureSwitchesRoutes],
    isolatePg: true,
  });
  await identity();
  await enable();
  await accept(clients().guide.import({ headers, body: draft() }), [403]);
  await accept(
    clients().guide.publish({
      headers,
      params: { editionId: "unknown-edition" },
      body: { revisionId: null },
    }),
    [403],
  );
  await expect(current()).resolves.toBeNull();
});

test("does not let the caller mark another owner or an unpublished revision as seen", async () => {
  await setupApp({
    context,
    routes: [...featureGuidesRoutes, ...featureSwitchesRoutes],
    isolatePg: true,
  });
  const prepared = await prepare();
  await identity();
  await enable();
  await accept(
    clients().guide.seen({
      headers,
      params: { editionId: prepared.editionId },
      body: { revisionId: prepared.revisionId },
    }),
    [404],
  );
  await publish(prepared);
  await identity();
  await enable();
  await accept(
    clients().guide.seen({
      headers,
      params: { editionId: prepared.editionId },
      body: { revisionId: randomUUID() },
    }),
    [404],
  );
  await expect(current()).resolves.not.toBeNull();
});

test("requires a session and validates content and publication windows", async () => {
  await setupApp({
    context,
    routes: [...featureGuidesRoutes, ...featureSwitchesRoutes],
    isolatePg: true,
  });
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

test("allows replay only in preview deployments without changing normal seen status", async () => {
  await setupApp({
    context,
    routes: [...featureGuidesRoutes, ...featureSwitchesRoutes],
    isolatePg: true,
  });
  const prepared = await prepare();
  await publish(prepared);
  await identity();
  await enable();
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
  const replay = await accept(
    clients().guide.current({ headers, query: { preview: "1" } }),
    [200],
  );
  expect(replay.body).toMatchObject({
    preview: true,
    edition: { id: prepared.editionId },
  });
  await expect(current()).resolves.toBeNull();
  mockOptionalEnv("ENV", "production");
  await accept(
    clients().guide.current({ headers, query: { preview: "1" } }),
    [403],
  );
});
