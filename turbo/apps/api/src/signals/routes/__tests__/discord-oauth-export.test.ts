import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { expect, onTestFinished, test } from "vitest";
import { iso, literal, object, string, uuid } from "zod";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import { userExportContract } from "@okouai/api-contracts/contracts/user-export";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { discordOauthRoutes } from "../discord-oauth";
import { userExportRoutes } from "../user-export";
import { createBddApi } from "./helpers/api-bdd";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
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

async function startAttempt(user: DiscordActor, guildId: string) {
  return await accept(
    setupApp({ context, routes: discordOauthRoutes })(
      discordOauthContract,
    ).start({
      headers: authenticate(user),
      body: { guildId },
    }),
    [200],
  );
}

test("downloads only the requesting owner's OAuth export content without capabilities through the normal export request", async () => {
  configureDiscordApp();
  const owner = actor();
  const peer = {
    ...actor(),
    orgId: owner.orgId,
    orgRole: "org:member" as const,
  };
  const otherInstaller = actor();
  const actors = [owner, peer, otherInstaller];
  mockDiscordMemberships(context, actors);
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
  const otherInstallation = await createPublicDiscordBinding(context, {
    ...otherInstaller,
    flow: "install",
  });
  onTestFinished(async () => {
    mockDiscordMemberships(context, actors);
    await removePublicDiscordBinding(context, peerBinding);
    await removePublicDiscordBinding(context, otherInstallation);
    await removePublicDiscordBinding(context, binding);
  });
  const ownAttempt = await startAttempt(owner, binding.guildId);
  const peerAttempt = await startAttempt(peer, binding.guildId);
  const storage = installDurableUserExportStorage(context);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ role: owner.orgRole, organization: { id: owner.orgId } }],
    totalCount: 1,
  });
  const client = setupApp({ context, routes: userExportRoutes })(
    userExportContract,
  );
  const started = await accept(
    client.post({ headers: authenticate(owner) }),
    [202],
  );
  await flushWaitUntilForTest();
  const status = await accept(
    client.get({ headers: authenticate(owner) }),
    [200],
  );
  expect(status.body.job).toMatchObject({
    id: started.body.jobId,
    status: "completed",
    error: null,
  });
  const downloadUrl = status.body.job?.downloadUrl;
  if (!downloadUrl) {
    throw new Error("Completed export must expose its download URL");
  }
  const zip = new AdmZip(storage.download(downloadUrl));
  expect(zip.test()).toBeTruthy();
  const entries = zip.getEntries();
  const documents = entries
    .filter((entry) => {
      return entry.entryName.startsWith("integrations/discord/oauth-attempts/");
    })
    .map((entry) => {
      const document: unknown = JSON.parse(zip.readAsText(entry));
      return document;
    });
  expect(documents).toHaveLength(1);
  const attempt = object({
    id: uuid(),
    orgId: string(),
    userId: string(),
    flow: literal("connect"),
    phase: literal("pending"),
    guildId: string(),
    createdAt: iso.datetime(),
    expiresAt: iso.datetime(),
  })
    .strict()
    .parse(documents[0]);
  expect(attempt).toMatchObject({
    userId: owner.userId,
    orgId: owner.orgId,
    guildId: binding.guildId,
  });
  const consents = entries
    .filter((entry) => {
      return entry.entryName.startsWith(
        "integrations/discord/personal-consents/",
      );
    })
    .map((entry) => {
      const document: unknown = JSON.parse(zip.readAsText(entry));
      return document;
    });
  expect(consents).toHaveLength(1);
  const consent = object({
    id: uuid(),
    orgId: string(),
    userId: string(),
    flow: literal("install"),
    guildId: string(),
    discordUserId: string(),
    botUserId: string(),
    createdAt: iso.datetime(),
  })
    .strict()
    .parse(consents[0]);
  expect(consent).toMatchObject({
    orgId: owner.orgId,
    userId: owner.userId,
    guildId: binding.guildId,
    discordUserId: binding.discordUserId,
  });
  const installationConsents = entries.filter((entry) => {
    return entry.entryName.startsWith(
      "integrations/discord/installation-consents/",
    );
  });
  expect(installationConsents).toHaveLength(0);
  const contents = entries
    .map((entry) => {
      return `${entry.entryName}\n${zip.readAsText(entry)}`;
    })
    .join("\n");
  const ownState = new URL(ownAttempt.body.authorizationUrl).searchParams.get(
    "state",
  );
  for (const hidden of [
    peer.userId,
    peerBinding.discordUserId,
    otherInstaller.userId,
    otherInstaller.orgId,
    otherInstallation.guildId,
    otherInstallation.discordUserId,
    ownAttempt.body.completionToken,
    peerAttempt.body.completionToken,
    ownState,
  ]) {
    if (hidden === null) {
      throw new Error("Issued authorization must include state");
    }
    expect(contents).not.toContain(hidden);
    expect(contents).not.toContain(
      createHash("sha256").update(hidden).digest("hex"),
    );
  }
});
