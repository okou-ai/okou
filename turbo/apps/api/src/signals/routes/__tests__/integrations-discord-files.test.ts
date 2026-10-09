import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  integrationsDiscordDownloadFileContract,
  integrationsDiscordUploadCompleteContract,
  integrationsDiscordUploadInitContract,
  integrationsDiscordUploadMaterializeContract,
  MAX_DISCORD_FILE_SIZE_BYTES,
  type DiscordUploadInitBody,
} from "@okouai/api-contracts/contracts/integrations-discord-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";
import { claimPublicToolRun } from "./helpers/public-tool-actor";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { configureDiscordApp, mockDiscordMemberships } from "./helpers/discord";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { integrationsDiscordFileRoutes } from "../integrations-discord-files";
const context = testContext();
const bdd = createBddApi(context);
const channelId = "123456789012345678",
  messageId = "223456789012345678",
  attachmentId = "323456789012345678";
function fileClients() {
  const app = setupApp({ context, routes: integrationsDiscordFileRoutes });
  return {
    init: app(integrationsDiscordUploadInitContract).init,
    materialize: app(integrationsDiscordUploadMaterializeContract).materialize,
    complete: app(integrationsDiscordUploadCompleteContract).complete,
    download: app(integrationsDiscordDownloadFileContract).download,
  };
}

function uploadBody(
  overrides: Partial<DiscordUploadInitBody> = {},
): DiscordUploadInitBody {
  return {
    filename: "report.csv",
    length: 8,
    contentType: "text/csv",
    checksumSha256: "a".repeat(64),
    operationId: randomUUID(),
    channelId,
    ...overrides,
  };
}

async function actorSession(options: Parameters<typeof bdd.user>[0] = {}) {
  const actor = bdd.user(options);
  if (!actor.orgId) {
    throw new Error("Discord file test actor must have an organization");
  }
  await bdd.readMe(actor);
  return { ...actor, orgId: actor.orgId };
}

describe("Discord file authorization and input validation", () => {
  it("requires authentication for every file endpoint", async () => {
    const client = fileClients();
    const operation = { assetId: randomUUID(), operationId: randomUUID() };
    const responses = [
      await accept(client.init({ headers: {}, body: uploadBody() }), [401]),
      await accept(client.materialize({ headers: {}, body: operation }), [401]),
      await accept(client.complete({ headers: {}, body: operation }), [401]),
      await accept(
        client.download({
          headers: {},
          query: { channelId, messageId, attachmentId },
        }),
        [401],
      ),
    ];

    for (const response of responses) {
      expect(response.body.error.code).toBe("UNAUTHORIZED");
    }
  });
  it("requires native read or write capability for sandbox requests", async () => {
    const actor = await actorSession();
    await publicPlanLifecycle(context, actor).update("active");
    const claimed = await claimPublicToolRun(context, actor, onTestFinished);
    const headers = { authorization: `Bearer ${claimed.claim.sandboxToken}` };
    const client = fileClients();
    const upload = await accept(
      client.init({ headers, body: uploadBody() }),
      [403],
    );
    const download = await accept(
      client.download({
        headers,
        query: { channelId, messageId, attachmentId },
      }),
      [403],
    );

    expect(upload.body.error.message).toContain("discord:write");
    expect(download.body.error.message).toContain("discord:read");
  });
  it("keeps file reads and writes unavailable while Discord is disabled", async () => {
    const actor = await actorSession();
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.DiscordIntegration]: false,
    });
    const client = fileClients();
    const headers = { authorization: "Bearer clerk-session" };
    const upload = await accept(
      client.init({ headers, body: uploadBody() }),
      [403],
    );
    const download = await accept(
      client.download({
        headers,
        query: { channelId, messageId, attachmentId },
      }),
      [403],
    );

    expect(upload.body.error.code).toBe("FORBIDDEN");
    expect(download.body.error.code).toBe("FORBIDDEN");
  });
  it("rejects an enabled but unbound caller", async () => {
    const actor = await actorSession();
    configureDiscordApp();
    mockDiscordMemberships(context, [actor]);
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.DiscordIntegration]: true,
    });
    const response = await accept(
      fileClients().download({
        headers: { authorization: "Bearer clerk-session" },
        query: { channelId, messageId, attachmentId },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
  it.each([
    { filename: "../report.csv" },
    { filename: "report\r\n.csv" },
    { filename: "report\\private.csv" },
    { filename: "." },
    { length: MAX_DISCORD_FILE_SIZE_BYTES + 1 },
    { length: 0 },
    { checksumSha256: "not-a-checksum" },
    { channelId: "1e18" },
  ])("rejects malformed upload metadata: %j", async (invalid) => {
    await actorSession();
    const response = await accept(
      fileClients().init({
        headers: { authorization: "Bearer clerk-session" },
        body: uploadBody(invalid),
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });
  it("rejects download identifiers that cannot identify a Discord attachment", async () => {
    await actorSession();
    const response = await accept(
      fileClients().download({
        headers: { authorization: "Bearer clerk-session" },
        query: {
          channelId,
          messageId,
          attachmentId: "../../credentials",
        },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });
});
