import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { aroundEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { withMockNowForTest } from "../../../lib/time";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import {
  computerUseToken,
  createComputerUseBddApi,
} from "./helpers/api-bdd-computer-use";

const context = testContext();
const bdd = createBddApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-19T02:00:00.000Z");
const CASE_TIMEOUT_MS = 30_000;

interface StoredContentFixture {
  readonly commandId: string;
  readonly host: { readonly hostId: string; readonly hostToken: string };
  readonly bytes: Buffer;
  readonly contentType: string;
}

interface DownloadedContent {
  readonly bytes: Buffer;
  readonly contentType: string | null;
  readonly contentLength: string | null;
  readonly cacheControl: string | null;
  readonly contentDisposition: string | null;
}

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

function orgScoped(
  actor: ApiTestUser,
): ApiTestUser & { readonly orgId: string } {
  if (actor.orgId === null) {
    throw new Error("Computer Use content reads require an organization");
  }
  return { ...actor, orgId: actor.orgId };
}

function agentTokenFor(
  actor: ApiTestUser & { readonly orgId: string },
  hostId: string | undefined,
  capabilities: readonly Capability[] = ["computer-use:write"],
): string {
  mockClerkMembership(context, actor, "org:admin");
  return computerUseToken({
    userId: actor.userId,
    orgId: actor.orgId,
    capabilities,
    ...(hostId ? { computerUseHostId: hostId } : {}),
    // Command content auth deliberately retains the run-less Agent-token shape.
    runId: `run_${randomUUID()}`,
  }).token;
}

async function createStoredContent(
  actor: ApiTestUser & { readonly orgId: string },
): Promise<StoredContentFixture> {
  const host = await computerUse.startComputerUseHost(actor, {
    hostName: "Screenshot Desktop",
  });
  const created = await computerUse.createComputerUseReadCommand(actor, {
    kind: "app.state",
    app: "Safari",
  });
  const claimed = await computerUse.claimNextComputerUseCommand(host.hostToken);
  expect(claimed).toMatchObject({
    status: "command",
    command: { id: created.commandId },
  });
  const bytes = Buffer.from("private screenshot bytes 中文🙂");
  await computerUse.completeComputerUseCommandWith(
    host.hostToken,
    created.commandId,
    {
      status: "succeeded",
      result: {
        snapshotId: "content_fence_screenshot",
        screenshot: `data:image/png;base64,${bytes.toString("base64")}`,
        screenshotWidth: 1440,
        screenshotHeight: 900,
      },
    },
  );
  return {
    commandId: created.commandId,
    host,
    bytes,
    contentType: "image/png",
  };
}

async function requestContent(
  auth: ApiTestUser | { readonly bearer: string } | null,
  commandId: string,
  statuses: readonly (200 | 401 | 403 | 404)[],
  signal?: AbortSignal,
) {
  return await computerUse.requestComputerUseScreenshot(
    auth,
    commandId,
    statuses,
    signal,
  );
}

async function downloadContent(
  fixture: Pick<StoredContentFixture, "commandId">,
  auth: ApiTestUser | { readonly bearer: string },
  signal?: AbortSignal,
): Promise<DownloadedContent> {
  const downloaded = await computerUse.downloadComputerUseScreenshot(
    auth,
    fixture.commandId,
    signal,
  );
  return downloaded;
}

function expectOpaqueNotFound(body: unknown): void {
  expect(body).toStrictEqual({
    error: {
      message: "Computer-use command screenshot not found",
      code: "NOT_FOUND",
    },
  });
}

function expectDownload(
  downloaded: DownloadedContent,
  fixture: StoredContentFixture,
): void {
  expect(downloaded.bytes.equals(fixture.bytes)).toBeTruthy();
  expect(downloaded.contentType).toBe(fixture.contentType);
  expect(downloaded.contentLength).toBe(String(fixture.bytes.length));
  expect(downloaded.cacheControl).toBe("private, no-store");
  expect(downloaded.contentDisposition).toBeNull();
}

describe("Computer Use binary content reads", () => {
  it(
    "preserves screenshot auth, exact ownership, bytes and response headers",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const sameOrgPeer = orgScoped(bdd.user({ orgId: actor.orgId }));
      const foreignOrg = orgScoped(bdd.user({ orgId: `org_${randomUUID()}` }));
      const fixture = await createStoredContent(actor);

      const unauthenticated = await requestContent(
        null,
        fixture.commandId,
        [401],
      );
      expectApiError(unauthenticated.body);
      const missingOrganization = await requestContent(
        bdd.user({ orgId: null }),
        fixture.commandId,
        [401],
      );
      expectApiError(missingOrganization.body);

      expectDownload(await downloadContent(fixture, actor), fixture);
      const { token: pat } = await authOrg.createCliToken(actor);
      mockClerkMembership(context, actor, "org:admin");
      expectDownload(await downloadContent(fixture, { bearer: pat }), fixture);
      const agentToken = agentTokenFor(actor, fixture.host.hostId);
      expectDownload(
        await downloadContent(fixture, { bearer: agentToken }),
        fixture,
      );

      const wrongHost = await computerUse.startComputerUseHost(actor, {
        hostName: "Wrong Host",
      });
      const wrongHostRead = await requestContent(
        { bearer: agentTokenFor(actor, wrongHost.hostId) },
        fixture.commandId,
        [404],
      );
      expectOpaqueNotFound(wrongHostRead.body);
      const missingCapability = await requestContent(
        {
          bearer: agentTokenFor(actor, fixture.host.hostId, []),
        },
        fixture.commandId,
        [403],
      );
      expectApiError(missingCapability.body);
      const unbound = await requestContent(
        { bearer: agentTokenFor(actor, undefined) },
        fixture.commandId,
        [403],
      );
      expect(unbound.body).toStrictEqual({
        error: {
          message: "Computer-use host is not authorized for this run",
          code: "FORBIDDEN",
        },
      });

      for (const foreignActor of [sameOrgPeer, foreignOrg]) {
        const denied = await requestContent(
          foreignActor,
          fixture.commandId,
          [404],
        );
        expectOpaqueNotFound(denied.body);
      }
      expect(fake.gets).toHaveLength(3);
      expect(
        fake.gets.every((get) => {
          return get.signal instanceof AbortSignal;
        }),
      ).toBeTruthy();
    },
  );

  it(
    "retains screenshot missing, non-success and null-pointer opacity without S3",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const host = await computerUse.startComputerUseHost(actor, {
        hostName: "Pointer Desktop",
      });
      const unknown = await requestContent(actor, randomUUID(), [404]);
      expectOpaqueNotFound(unknown.body);
      const created = await computerUse.createComputerUseReadCommand(actor, {
        kind: "app.state",
        app: "Safari",
      });
      const queued = await requestContent(actor, created.commandId, [404]);
      expectOpaqueNotFound(queued.body);
      await computerUse.claimNextComputerUseCommand(host.hostToken);
      await computerUse.completeComputerUseCommandWith(
        host.hostToken,
        created.commandId,
        {
          status: "succeeded",
          result: { screenshot: null },
        },
      );
      const pointerNull = await requestContent(actor, created.commandId, [404]);
      expectOpaqueNotFound(pointerNull.body);
      expect(fake.gets).toStrictEqual([]);
    },
  );
});
