import AdmZip from "adm-zip";
import { expect, onTestFinished, test } from "vitest";
import { z } from "zod";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { discordOauthRoutes } from "../discord-oauth";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { cronProcessBackgroundJobsRoutes } from "../cron-process-background-jobs";
import { createBddApi } from "./helpers/api-bdd";
import { createOpsLogsApi } from "./helpers/api-bdd-ops-logs";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import {
  configureDiscordApp,
  createPublicDiscordBinding,
  mockDiscordMemberships,
  removePublicDiscordBinding,
  type DiscordActor,
} from "./helpers/discord";

const context = testContext();

function actor() {
  const user = createBddApi(context).user();
  if (!user.orgId) {
    throw new Error("Discord export requires a workspace");
  }
  return { ...user, orgId: user.orgId };
}

function authenticate(user: DiscordActor) {
  createRouteMocks(context).clerk.session(
    user.userId,
    user.orgId,
    user.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

async function startPendingAuthorization(user: DiscordActor, guildId: string) {
  return await accept(
    setupApp({ context, routes: discordOauthRoutes })(
      discordOauthContract,
    ).start({
      headers: authenticate(user),
      body: { flow: "connect", guildId },
    }),
    [200],
  );
}

test("exports only the owner's Discord binding and OAuth attempt without authorization capabilities", async () => {
  configureDiscordApp();
  mockEnv("CRON_SECRET", "discord-export-cron-secret");
  const owner = actor();
  const peer = {
    ...actor(),
    orgId: owner.orgId,
    orgRole: "org:member" as const,
  };
  mockDiscordMemberships(context, [owner, peer]);
  for (const user of [owner, peer]) {
    await updateFeatureSwitchesForUser(context, user, {
      [FeatureSwitchKey.DiscordIntegration]: true,
    });
  }
  const binding = await createPublicDiscordBinding(context, {
    ...owner,
    flow: "install",
  });
  const peerBinding = await createPublicDiscordBinding(context, {
    ...peer,
    flow: "connect",
    guildId: binding.guildId,
    botUserId: binding.botUserId,
  });
  onTestFinished(async () => {
    mockDiscordMemberships(context, [owner, peer]);
    await removePublicDiscordBinding(context, peerBinding);
    await removePublicDiscordBinding(context, binding);
  });
  await accept(
    setupApp({ context, routes: integrationsDiscordRoutes })(
      integrationsDiscordContract,
    ).setDmSelection({
      headers: authenticate(owner),
      body: { connectionId: binding.connectionId },
    }),
    [200],
  );
  const ownAttempt = await startPendingAuthorization(owner, binding.guildId);
  const peerAttempt = await startPendingAuthorization(peer, binding.guildId);
  const storage = installDurableUserExportStorage(context);
  const exports = createOpsLogsApi(context);
  const started = await exports.requestPostUserExport(owner, [202]);
  await flushWaitUntilForTest();
  await accept(
    setupApp({ context, routes: cronProcessBackgroundJobsRoutes })(
      cronProcessBackgroundJobsContract,
    ).process({
      headers: { authorization: "Bearer discord-export-cron-secret" },
    }),
    [200],
  );
  const completed = await exports.requestGetUserExport(owner, [200]);
  expect(completed.body.job).toMatchObject({
    id: started.body.jobId,
    status: "completed",
  });
  const url = completed.body.job?.downloadUrl;
  if (!url) {
    throw new Error("The completed export must have a download URL");
  }
  const zip = new AdmZip(storage.download(url));
  const entries = zip.getEntries().filter((entry) => {
    return entry.entryName.startsWith("integrations/discord/");
  });
  const read = (kind: string) => {
    return entries
      .filter((entry) => {
        return entry.entryName.startsWith(`integrations/discord/${kind}/`);
      })
      .map((entry) => {
        return JSON.parse(entry.getData().toString("utf8")) as unknown;
      });
  };
  expect(read("installations")).toStrictEqual([
    expect.objectContaining({
      guildId: binding.guildId,
      installedByUserId: owner.userId,
    }),
  ]);
  expect(read("connections")).toStrictEqual([
    expect.objectContaining({
      id: binding.connectionId,
      userId: owner.userId,
      discordUserId: binding.discordUserId,
    }),
  ]);
  expect(read("dm-preferences")).toStrictEqual([
    expect.objectContaining({
      connectionId: binding.connectionId,
      userId: owner.userId,
    }),
  ]);
  const attempts = read("oauth-attempts");
  expect(attempts).toHaveLength(1);
  const attempt = z
    .object({
      id: z.uuid(),
      orgId: z.string(),
      userId: z.string(),
      flow: z.literal("connect"),
      phase: z.literal("pending"),
      guildId: z.string(),
      createdAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
    })
    .strict()
    .parse(attempts[0]);
  expect(attempt).toMatchObject({
    userId: owner.userId,
    orgId: owner.orgId,
    guildId: binding.guildId,
  });
  const contents = entries
    .map((entry) => {
      return entry.getData().toString("utf8");
    })
    .join("\n");
  for (const hidden of [
    peer.userId,
    peerBinding.discordUserId,
    ownAttempt.body.completionToken,
    peerAttempt.body.completionToken,
  ]) {
    expect(contents).not.toContain(hidden);
  }
});
