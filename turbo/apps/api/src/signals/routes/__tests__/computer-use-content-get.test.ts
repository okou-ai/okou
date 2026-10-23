import { randomUUID } from "node:crypto";

import { aroundEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { withMockNowForTest } from "../../../lib/time";
import { expectApiError, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";

const context = testContext();
const STARTED_AT_MS = Date.parse("2026-09-19T02:00:00.000Z");

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

async function createStoredContent(
  computerUse: ReturnType<
    typeof createPublicComputerUseScenario
  >["computerUse"],
  actor: ApiTestUser,
) {
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
  return { commandId: created.commandId, host, size: bytes.length };
}

describe("Computer Use screenshot download URLs", () => {
  it(
    "returns private screenshot metadata with owner and host authorization",
    { timeout: 30_000 },
    async () => {
      const scenario = createPublicComputerUseScenario(context);
      const { computerUse } = scenario;
      return await scenario.run(async () => {
        computerUse.installComputerUseS3Fake();
        const actor = scenario.user();
        const sameOrgPeer = scenario.user({ orgId: actor.orgId });
        const foreignOrg = scenario.user({ orgId: `org_${randomUUID()}` });
        const fixture = await createStoredContent(computerUse, actor);
        const metadata = {
          downloadUrl: expect.stringContaining(
            encodeURIComponent(`${fixture.commandId}/screenshot.png`),
          ),
          filename: "screenshot.png",
          contentType: "image/png",
          size: fixture.size,
          cacheControl: "private, no-store",
        };

        const unauthenticated = await computerUse.requestComputerUseScreenshot(
          null,
          fixture.commandId,
          [401],
        );
        expectApiError(unauthenticated.body);
        const missingOrganization =
          await computerUse.requestComputerUseScreenshot(
            scenario.user({ orgId: null }),
            fixture.commandId,
            [401],
          );
        expectApiError(missingOrganization.body);

        await expect(
          computerUse.resolveComputerUseScreenshot(actor, fixture.commandId),
        ).resolves.toStrictEqual(metadata);
        const { token: pat } = await scenario.createCliToken(actor);
        mockClerkMembership(context, actor, "org:admin");
        await expect(
          computerUse.resolveComputerUseScreenshot(
            { bearer: pat },
            fixture.commandId,
          ),
        ).resolves.toStrictEqual(metadata);
        const agent = await scenario.claim(actor, fixture.host.hostId);
        await expect(
          computerUse.resolveComputerUseScreenshot(
            { bearer: agent.token },
            fixture.commandId,
          ),
        ).resolves.toStrictEqual(metadata);

        const wrongHost = await computerUse.startComputerUseHost(actor, {
          hostName: "Wrong Host",
        });
        const wrongHostAgent = await scenario.claim(actor, wrongHost.hostId);
        const deniedActors = [
          { bearer: wrongHostAgent.token },
          sameOrgPeer,
          foreignOrg,
        ];
        for (const deniedActor of deniedActors) {
          const denied = await computerUse.requestComputerUseScreenshot(
            deniedActor,
            fixture.commandId,
            [404],
          );
          expect(denied.body).toStrictEqual({
            error: {
              message: "Computer-use command screenshot not found",
              code: "NOT_FOUND",
            },
          });
        }
        const unboundAgent = await scenario.claim(actor, undefined);
        const unbound = await computerUse.requestComputerUseScreenshot(
          { bearer: unboundAgent.token },
          fixture.commandId,
          [403],
        );
        expectApiError(unbound.body);
      });
    },
  );
});
