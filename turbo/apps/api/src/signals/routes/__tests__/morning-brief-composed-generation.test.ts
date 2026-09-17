import { randomUUID } from "node:crypto";

import { morningBriefCompositionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-composition-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MORNING_BRIEF_COLLECTION_VERSION } from "@okouai/db/schema/morning-brief-collection-occurrence";
import { morningBriefGenerations } from "@okouai/db/schema/morning-brief-generation";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { db } from "../../../lib/db";
import { mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  readMorningBriefCollectionOccurrences,
  seedInstalledMorningBrief,
} from "../../../test-fixtures/morning-brief-collection";
import {
  readMorningBriefGenerations,
  readOwnerBillingFootprint,
  readPlatformGenerationReceipts,
} from "../../../test-fixtures/morning-brief-generation";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { morningBriefCompositionPreviewRoutes } from "../morning-brief-composition-preview";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

/**
 * The real registered entry point for source-independent generation.
 *
 * Every case here goes through the deployed route, the deployed admission and a
 * real database. The provider boundary is a double, and the point of counting
 * its requests is that the cases below prove when a request is *not* made.
 */

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const ANCHOR_MS = Math.floor((now() - 60 * 60 * 1000) / 1000) * 1000;
const ANCHOR = new Date(ANCHOR_MS).toISOString();

afterEach(() => {
  clearMockNow();
});

function client() {
  return setupApp({ context, routes: morningBriefCompositionPreviewRoutes })(
    morningBriefCompositionPreviewContract,
  );
}

function agentToken(
  userId: string,
  orgId: string,
): { readonly authorization: string } {
  const seconds = Math.floor(now() / 1000);
  return {
    authorization: `Bearer ${signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId,
      runId: randomUUID(),
      capabilities: ["agent:read"],
      iat: seconds,
      exp: seconds + 3600,
    })}`,
  };
}

/** Count every provider request the route makes, including refused ones. */
function countProviderRequests(): { readonly total: () => number } {
  let total = 0;
  server.use(
    http.post(OPENROUTER_URL, () => {
      total += 1;
      return HttpResponse.json({ error: { message: "unexpected" } });
    }),
  );
  return {
    total: () => {
      return total;
    },
  };
}

interface Fixture {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly headers: { readonly authorization: string };
}

/**
 * An owner with the brief installed and **no connector at all**.
 *
 * No Slack installation is seeded on purpose: a composed brief must be
 * reachable for an owner who has none, and nothing may substitute a Slack
 * identity for them.
 */
async function seedOwnerWithoutConnectors(): Promise<Fixture> {
  // Building the app first is what wires the shared boundary doubles this
  // fixture then programs.
  client();
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "member" },
    context.signal,
  );
  const installed = await seedInstalledMorningBrief({ orgId, userId });
  mocks.clerk.session(userId, orgId);
  await updateFeatureSwitchesForUser(orgId, userId, {
    [FeatureSwitchKey.SimpleMorningBrief]: true,
  });
  mocks.clerk.session(userId, orgId);
  mockOptionalEnv("OPENROUTER_API_KEY", "sk-test-platform-key");
  return {
    orgId,
    userId,
    workflowId: installed.workflowId,
    automationId: installed.automationId,
    headers: agentToken(userId, orgId),
  };
}

describe("composed Morning Brief generation", () => {
  it("reaches the composed engine for an owner with no connectors and sends nothing", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    const provider = countProviderRequests();

    const response = await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [200],
    );

    // Every configured source answered with nothing, so this settles as a
    // healthy empty morning: zero provider requests and zero platform spend.
    expect(response.body.result).toBe("generated");
    expect(provider.total()).toBe(0);
    expect(await readPlatformGenerationReceipts()).toHaveLength(0);

    // The occurrence is source-independent, and it carries no Slack identity.
    const occurrences = await readMorningBriefCollectionOccurrences({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.collectionKind).toBe("sources");
    expect(occurrences[0]?.slackWorkspaceId).toBeNull();
    expect(occurrences[0]?.slackUserId).toBeNull();

    const generations = await readMorningBriefGenerations({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(generations).toHaveLength(1);
    expect(generations[0]?.state).toBe("skipped_empty");
    expect(generations[0]?.collectionKind).toBe("sources");

    // Okou pays for this pipeline, so the owner's ledger must be untouched.
    const footprint = await readOwnerBillingFootprint({
      orgId: fixture.orgId,
      workflowId: fixture.workflowId,
      automationId: fixture.automationId,
    });
    expect(footprint.usageEvents).toHaveLength(0);
    expect(footprint.allowanceWindows).toHaveLength(0);
    expect(footprint.runs).toHaveLength(0);
  });

  it("refuses a second invocation for a morning a Slack-kind attempt may already have sent", async () => {
    const fixture = await seedOwnerWithoutConnectors();
    const provider = countProviderRequests();
    const reservedAt = new Date(ANCHOR_MS);

    // A Slack-only generation that is merely `reserved` is already ambiguous:
    // the reservation commits before the request, so it may have reached the
    // provider. Widening the source set must never turn that into a resend.
    await db()
      .insert(morningBriefGenerations)
      .values({
        orgId: fixture.orgId,
        userId: fixture.userId,
        scheduledFor: new Date(ANCHOR_MS),
        collectionKind: "slack",
        collectionVersion: MORNING_BRIEF_COLLECTION_VERSION,
        executionPurpose: "preview",
        attemptId: randomUUID(),
        state: "reserved",
        membershipId: `orgmem_${randomUUID()}`,
        agentId: randomUUID(),
        model: "google/gemini-3.8-flash",
        promptVersion: 1,
        resultSchemaVersion: 1,
        language: "en-US",
        languageSource: "default",
        inputDigest: "deadbeef",
        inputItems: 1,
        includedItems: 1,
        inputReduced: false,
        sourceCoverage: "complete",
        reservedAt,
        reservationExpiresAt: new Date(reservedAt.getTime() + 60_000),
        expiresAt: new Date(reservedAt.getTime() + 24 * 60 * 60 * 1000),
      })
      .onConflictDoNothing();

    const response = await accept(
      client().generate({
        headers: fixture.headers,
        body: { anchor: ANCHOR },
      }),
      [409],
    );

    expect(response.body).toMatchObject({
      error: { code: "MORNING_BRIEF_GENERATION_CONFLICT" },
    });
    expect(provider.total()).toBe(0);

    // The historical Slack slot is untouched: it stays exactly as invocable —
    // or as non-invocable — as it was, and no second slot was created for it.
    const generations = await readMorningBriefGenerations({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
    expect(generations).toHaveLength(1);
    expect(generations[0]?.collectionKind).toBe("slack");
    expect(generations[0]?.state).toBe("reserved");
  });
});
