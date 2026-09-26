import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import {
  COMPUTER_USE_FILESYSTEM_PLUGIN,
  COMPUTER_USE_PLUGIN_CALL_KIND,
  computerUsePluginCapability,
  computerUsePluginToolCapability,
} from "@okouai/api-contracts/contracts/computer-use-plugins";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-19T02:00:00.000Z");
const CASE_TIMEOUT_MS = 30_000;

type ContentKind = "screenshot" | "plugin";

interface StoredContentFixture {
  readonly kind: ContentKind;
  readonly commandId: string;
  readonly host: { readonly hostId: string; readonly hostToken: string };
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly fileName: string | null;
}

interface DownloadedContent {
  readonly bytes: Buffer;
  readonly contentType: string | null;
  readonly contentLength: string | null;
  readonly cacheControl: string | null;
  readonly contentDisposition: string | null;
  readonly fileName: string | null;
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

function filesystemCapabilities(): readonly string[] {
  return [
    COMPUTER_USE_PLUGIN_CALL_KIND,
    computerUsePluginCapability(COMPUTER_USE_FILESYSTEM_PLUGIN),
    computerUsePluginToolCapability(
      COMPUTER_USE_FILESYSTEM_PLUGIN,
      "read_text_file",
    ),
  ];
}

async function enableComputerUsePlugins(
  actor: ApiTestUser & { readonly orgId: string },
): Promise<void> {
  await updateFeatureSwitchesForUser(
    context,
    {
      userId: actor.userId,
      orgId: actor.orgId,
      orgRole: actor.orgRole,
    },
    { [FeatureSwitchKey.ComputerUseDesktopPlugins]: true },
  );
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
  kind: ContentKind,
  actor: ApiTestUser & { readonly orgId: string },
): Promise<StoredContentFixture> {
  if (kind === "screenshot") {
    const host = await computerUse.startComputerUseHost(actor, {
      hostName: "Screenshot Desktop",
    });
    const created = await computerUse.createComputerUseReadCommand(actor, {
      kind: "app.state",
      app: "Safari",
    });
    const claimed = await computerUse.claimNextComputerUseCommand(
      host.hostToken,
    );
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
      kind,
      commandId: created.commandId,
      host,
      bytes,
      contentType: "image/png",
      fileName: null,
    };
  }

  await enableComputerUsePlugins(actor);
  const host = await computerUse.startComputerUseHost(actor, {
    hostName: "Plugin Desktop",
    supportedCapabilities: filesystemCapabilities(),
  });
  const created = await computerUse.createComputerUsePluginCommand(actor, {
    plugin: "filesystem",
    tool: "read_text_file",
    arguments: { path: "/tmp/private-notes.txt" },
  });
  const claimed = await computerUse.claimNextComputerUseCommand(
    host.hostToken,
    filesystemCapabilities(),
  );
  expect(claimed).toMatchObject({
    status: "command",
    command: { id: created.commandId },
  });
  const bytes = Buffer.from("private plugin bytes 中文🙂");
  await computerUse.completeComputerUseCommandWith(
    host.hostToken,
    created.commandId,
    {
      status: "succeeded",
      result: {
        plugin: "filesystem",
        tool: "read_text_file",
        sizeBytes: bytes.length,
        pluginContent: {
          dataBase64: bytes.toString("base64"),
          mimeType: "text/plain",
          fileName: 'private"notes".txt',
        },
      },
    },
  );
  return {
    kind,
    commandId: created.commandId,
    host,
    bytes,
    contentType: "text/plain",
    fileName: "privatenotes.txt",
  };
}

async function requestContent(
  kind: ContentKind,
  auth: ApiTestUser | { readonly bearer: string } | null,
  commandId: string,
  statuses: readonly (200 | 401 | 403 | 404)[],
  signal?: AbortSignal,
) {
  return kind === "screenshot"
    ? await computerUse.requestComputerUseScreenshot(
        auth,
        commandId,
        statuses,
        signal,
      )
    : await computerUse.requestComputerUsePluginContent(
        auth,
        commandId,
        statuses,
        signal,
      );
}

async function downloadContent(
  fixture: Pick<StoredContentFixture, "kind" | "commandId">,
  auth: ApiTestUser | { readonly bearer: string },
  signal?: AbortSignal,
): Promise<DownloadedContent> {
  if (fixture.kind === "screenshot") {
    const downloaded = await computerUse.downloadComputerUseScreenshot(
      auth,
      fixture.commandId,
      signal,
    );
    return {
      ...downloaded,
      contentDisposition: null,
      fileName: null,
    };
  }
  return await computerUse.downloadComputerUsePluginContent(
    auth,
    fixture.commandId,
    signal,
  );
}

function expectOpaqueNotFound(kind: ContentKind, body: unknown): void {
  expect(body).toStrictEqual({
    error: {
      message:
        kind === "screenshot"
          ? "Computer-use command screenshot not found"
          : "Computer-use plugin content not found",
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
  expect(downloaded.fileName).toBe(fixture.fileName);
  if (fixture.kind === "plugin") {
    expect(downloaded.contentDisposition).toBe(
      'attachment; filename="privatenotes.txt"',
    );
  } else {
    expect(downloaded.contentDisposition).toBeNull();
  }
}

describe("Computer Use binary content reads", () => {
  it.each(["screenshot", "plugin"] as const)(
    "preserves %s auth, exact ownership, bytes and response headers",
    { timeout: CASE_TIMEOUT_MS },
    async (kind) => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const sameOrgPeer = orgScoped(bdd.user({ orgId: actor.orgId }));
      const foreignOrg = orgScoped(bdd.user({ orgId: `org_${randomUUID()}` }));
      const fixture = await createStoredContent(kind, actor);

      const unauthenticated = await requestContent(
        kind,
        null,
        fixture.commandId,
        [401],
      );
      expectApiError(unauthenticated.body);
      const missingOrganization = await requestContent(
        kind,
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
        kind,
        { bearer: agentTokenFor(actor, wrongHost.hostId) },
        fixture.commandId,
        [404],
      );
      expectOpaqueNotFound(kind, wrongHostRead.body);
      const missingCapability = await requestContent(
        kind,
        {
          bearer: agentTokenFor(actor, fixture.host.hostId, []),
        },
        fixture.commandId,
        [403],
      );
      expectApiError(missingCapability.body);
      const unbound = await requestContent(
        kind,
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
          kind,
          foreignActor,
          fixture.commandId,
          [404],
        );
        expectOpaqueNotFound(kind, denied.body);
      }
      expect(fake.gets).toHaveLength(3);
      expect(
        fake.gets.every((get) => {
          return get.signal instanceof AbortSignal;
        }),
      ).toBeTruthy();
    },
  );

  it.each(["screenshot", "plugin"] as const)(
    "retains %s missing, non-success and null-pointer opacity without S3",
    { timeout: CASE_TIMEOUT_MS },
    async (kind) => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      if (kind === "plugin") {
        await enableComputerUsePlugins(actor);
      }
      const host = await computerUse.startComputerUseHost(actor, {
        hostName: "Pointer Desktop",
        ...(kind === "plugin"
          ? { supportedCapabilities: filesystemCapabilities() }
          : {}),
      });
      const unknown = await requestContent(kind, actor, randomUUID(), [404]);
      expectOpaqueNotFound(kind, unknown.body);

      const created =
        kind === "screenshot"
          ? await computerUse.createComputerUseReadCommand(actor, {
              kind: "app.state",
              app: "Safari",
            })
          : await computerUse.createComputerUsePluginCommand(actor, {
              plugin: "filesystem",
              tool: "read_text_file",
              arguments: { path: "/tmp/missing.txt" },
            });
      const queued = await requestContent(
        kind,
        actor,
        created.commandId,
        [404],
      );
      expectOpaqueNotFound(kind, queued.body);
      await computerUse.claimNextComputerUseCommand(
        host.hostToken,
        kind === "plugin" ? filesystemCapabilities() : undefined,
      );
      await computerUse.completeComputerUseCommandWith(
        host.hostToken,
        created.commandId,
        {
          status: "succeeded",
          result:
            kind === "screenshot"
              ? { screenshot: null }
              : { pluginContent: null },
        },
      );
      const pointerNull = await requestContent(
        kind,
        actor,
        created.commandId,
        [404],
      );
      expectOpaqueNotFound(kind, pointerNull.body);
      expect(fake.gets).toStrictEqual([]);
    },
  );
});
