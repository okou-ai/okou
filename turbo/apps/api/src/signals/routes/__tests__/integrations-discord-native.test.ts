import { describe, expect, it, onTestFinished } from "vitest";
import { integrationsDiscordReadContract } from "@okouai/api-contracts/contracts/integrations-discord-read";
import { integrationsDiscordMessageContract } from "@okouai/api-contracts/contracts/integrations-discord-message";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { integrationsDiscordReadRoutes } from "../integrations-discord-read";
import { integrationsDiscordMessageRoutes } from "../integrations-discord-message";
import { createBddApi } from "./helpers/api-bdd";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { claimPublicToolRun } from "./helpers/public-tool-actor";
import { deletePublicWorkspace } from "./helpers/public-workspace-cleanup";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { configureDiscordApp, uniqueDiscordSnowflake } from "./helpers/discord";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
const context = testContext();
describe("Discord native access before OAuth is available", () => {
  it("enforces default-off and token capabilities for reads and writes", async () => {
    const user = createBddApi(context).user();
    if (!user.orgId) {
      throw new Error("Expected a Discord workspace");
    }
    const actor = { ...user, orgId: user.orgId };
    onTestFinished(() => {
      return deletePublicWorkspace(context, actor);
    });
    configureDiscordApp();
    installDurableUserExportStorage(context, {
      prefixes: [`${actor.orgId}/`],
    });
    const storageSend = context.mocks.s3.send.getMockImplementation();
    const storageSignedUrl =
      context.mocks.s3.getSignedUrl.getMockImplementation();
    if (!storageSend || !storageSignedUrl) {
      throw new Error("Expected the case-owned S3 transport");
    }
    await publicPlanLifecycle(context, actor).update("active");
    await createBddApi(context).completeOnboarding(actor);
    const claimed = await claimPublicToolRun(context, actor, (cleanup) => {
      onTestFinished(async () => {
        context.mocks.s3.send.mockImplementation(storageSend);
        context.mocks.s3.getSignedUrl.mockImplementation(storageSignedUrl);
        await cleanup();
      });
    });
    const channelId = uniqueDiscordSnowflake();
    const read = setupApp({ context, routes: integrationsDiscordReadRoutes })(
      integrationsDiscordReadContract,
    );
    const message = setupApp({
      context,
      routes: integrationsDiscordMessageRoutes,
    })(integrationsDiscordMessageContract);
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.DiscordIntegration]: false,
    });
    await accept(
      read.history({ headers: claimed.headers, query: { channelId } }),
      [403],
    );
    await accept(
      message.sendMessage({
        headers: claimed.headers,
        body: { channelId, text: "hello" },
      }),
      [403],
    );
    const limited = { authorization: `Bearer ${claimed.claim.sandboxToken}` };
    expect(
      (
        await accept(
          read.history({ headers: limited, query: { channelId } }),
          [403],
        )
      ).body.error.message,
    ).toContain("discord:read");
    expect(
      (
        await accept(
          message.sendMessage({
            headers: limited,
            body: { channelId, text: "hello" },
          }),
          [403],
        )
      ).body.error.message,
    ).toContain("discord:write");
  });
});
