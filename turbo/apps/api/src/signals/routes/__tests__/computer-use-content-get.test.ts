import type { ComputerUseTestConnection } from "./helpers/api-bdd-computer-use";
import { randomUUID } from "node:crypto";

import { aroundEach, describe, expect, it } from "vitest";
import { computerUseCommandContract } from "@okouai/api-contracts/contracts/computer-use";

import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { withMockNowForTest } from "../../../lib/time";
import { settleIncludingAbort } from "../../utils";
import { computerUseRoutes } from "../computer-use";
import { expectApiError, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const STARTED_AT_MS = Date.parse("2026-09-19T02:00:00.000Z");
const CASE_TIMEOUT_MS = 30_000;

interface StoredContentFixture {
  readonly commandId: string;
  readonly host: {
    readonly hostId: string;
    readonly connection: ComputerUseTestConnection;
  };
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

function createScenario() {
  const scenario = createPublicComputerUseScenario(context);
  const bdd = { user: scenario.user };
  const computerUse = scenario.computerUse;
  const authOrg = { createCliToken: scenario.createCliToken };

  function orgScoped(
    actor: ApiTestUser,
  ): ApiTestUser & { readonly orgId: string } {
    if (actor.orgId === null) {
      throw new Error("Computer Use content reads require an organization");
    }
    return { ...actor, orgId: actor.orgId };
  }

  async function agentTokenFor(
    actor: ApiTestUser,
    hostId: string | undefined,
  ): Promise<string> {
    return (await scenario.claim(actor, hostId)).token;
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
    const claimed = await computerUse.claimNextComputerUseCommand(
      host.connection,
    );
    expect(claimed).toMatchObject({
      status: "command",
      command: { id: created.commandId },
    });
    const bytes = Buffer.from("private screenshot bytes 中文🙂");
    await computerUse.completeComputerUseCommandWith(
      host.connection,
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
  return {
    ...scenario,
    bdd,
    authOrg,
    computerUse,
    orgScoped,
    agentTokenFor,
    createStoredContent,
    requestContent,
    downloadContent,
    expectOpaqueNotFound,
    expectDownload,
  };
}

describe("Computer Use binary content reads", () => {
  it(
    "preserves screenshot auth, exact ownership, bytes and response headers",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const scenario = createScenario();
      const {
        bdd,
        authOrg,
        computerUse,
        orgScoped,
        agentTokenFor,
        createStoredContent,
        requestContent,
        downloadContent,
        expectOpaqueNotFound,
        expectDownload,
      } = scenario;
      return await scenario.run(async () => {
        const fake = computerUse.installComputerUseS3Fake();
        const actor = orgScoped(bdd.user());
        const sameOrgPeer = orgScoped(bdd.user({ orgId: actor.orgId }));
        const foreignOrg = orgScoped(
          bdd.user({ orgId: `org_${randomUUID()}` }),
        );
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
        expectDownload(
          await downloadContent(fixture, { bearer: pat }),
          fixture,
        );
        const agentToken = await agentTokenFor(actor, fixture.host.hostId);
        expectDownload(
          await downloadContent(fixture, { bearer: agentToken }),
          fixture,
        );

        const wrongHost = await computerUse.startComputerUseHost(actor, {
          hostName: "Wrong Host",
        });
        const wrongHostRead = await requestContent(
          { bearer: await agentTokenFor(actor, wrongHost.hostId) },
          fixture.commandId,
          [404],
        );
        expectOpaqueNotFound(wrongHostRead.body);
        const unbound = await requestContent(
          { bearer: await agentTokenFor(actor, undefined) },
          fixture.commandId,
          [403],
        );
        expectApiError(unbound.body);

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
      });
    },
  );

  it(
    "retains screenshot missing, non-success and null-pointer opacity without S3",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const scenario = createScenario();
      const {
        bdd,
        computerUse,
        orgScoped,
        requestContent,
        expectOpaqueNotFound,
      } = scenario;
      return await scenario.run(async () => {
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
        await computerUse.claimNextComputerUseCommand(host.connection);
        const running = await requestContent(actor, created.commandId, [404]);
        expectOpaqueNotFound(running.body);
        await computerUse.completeComputerUseCommandWith(
          host.connection,
          created.commandId,
          {
            status: "failed",
            error: { code: "app_not_found", message: "Desktop read failed" },
          },
        );
        const failed = await requestContent(actor, created.commandId, [404]);
        expectOpaqueNotFound(failed.body);

        const withoutScreenshot =
          await computerUse.createComputerUseReadCommand(actor, {
            kind: "app.state",
            app: "Safari",
          });
        await computerUse.claimNextComputerUseCommand(host.connection);
        await computerUse.completeComputerUseCommandWith(
          host.connection,
          withoutScreenshot.commandId,
          {
            status: "succeeded",
            result: { screenshot: null },
          },
        );
        const pointerNull = await requestContent(
          actor,
          withoutScreenshot.commandId,
          [404],
        );
        expectOpaqueNotFound(pointerNull.body);
        expect(fake.gets).toStrictEqual([]);
      });
    },
  );

  it.each(["GetObject", "body"] as const)(
    "stops a screenshot %s read when its API instance is cancelled",
    { timeout: CASE_TIMEOUT_MS },
    async (phase) => {
      const scenario = createScenario();
      return await scenario.run(async () => {
        const fake = scenario.computerUse.installComputerUseS3Fake();
        const actor = scenario.orgScoped(scenario.bdd.user());
        const fixture = await scenario.createStoredContent(actor);
        const owner = new AbortController();
        const barrier =
          phase === "GetObject"
            ? fake.holdNextGetObject()
            : fake.holdNextBody();
        createRouteMocks(context).clerk.session(
          actor.userId,
          actor.orgId,
          actor.orgRole,
        );
        const pending = settleIncludingAbort(() => {
          return setupApp({
            context,
            routes: computerUseRoutes,
            signal: AbortSignal.any([context.signal, owner.signal]),
            rethrowErrors: true,
          })(computerUseCommandContract).getScreenshot({
            headers: { authorization: "Bearer clerk-session" },
            params: { commandId: fixture.commandId },
          });
        });
        const cancelled = await settleIncludingAbort(async () => {
          const started = await Promise.race([barrier.entered, pending]);
          if ("ok" in started) {
            if (!started.ok) {
              throw started.error;
            }
            throw new Error("Screenshot request finished before storage hold");
          }
          owner.abort(
            new DOMException("Computer Use API instance stopped", "AbortError"),
          );
          await expect(pending).resolves.toMatchObject({
            ok: false,
            error: expect.objectContaining({ name: "AbortError" }),
          });
        });
        owner.abort();
        barrier.release();
        await pending;
        if (!cancelled.ok) {
          throw cancelled.error;
        }
        scenario.expectDownload(
          await scenario.downloadContent(fixture, actor),
          fixture,
        );
      });
    },
  );
});
