import { expect, test, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  deleteProjectionOwnedHistoricalFiles,
  retainedHistoricalFileExists,
  seedProjectionOwnedHistoricalFile,
} from "../../../test-fixtures/artifact-file-ownership";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);

test.each(["user", "organization"] as const)(
  "erases projection-owned historical files through the verified Clerk %s entrypoint",
  async (kind) => {
    const owner = bdd.user();
    const outsider = bdd.user();
    await runs.grantProEntitlement(owner);
    await runs.grantProEntitlement(outsider);
    if (!owner.orgId || !outsider.orgId) {
      throw new Error("Expected case-owned organizations");
    }
    // Historical infrastructure exception: current upload APIs cannot produce
    // a retained file with no Run/thread/queue and only registry ownership.
    // A legacy provider user and nullable file org remain legal persisted facts.
    // No production endpoint exposes physical orphan erasure once its registry
    // is gone, so verify that infrastructure invariant using the scoped receipt.
    // Actual deletion and catalog readback still use production endpoints.
    const owned = await seedProjectionOwnedHistoricalFile({
      userId: owner.userId,
      orgId: owner.orgId,
    });
    onTestFinished(async () => {
      await deleteProjectionOwnedHistoricalFiles([owned]);
    });
    const unrelated = await seedProjectionOwnedHistoricalFile({
      userId: outsider.userId,
      orgId: outsider.orgId,
    });
    onTestFinished(async () => {
      await deleteProjectionOwnedHistoricalFiles([unrelated]);
    });
    expect((await chat.listArtifactCatalog(owner)).artifacts).toContainEqual(
      expect.objectContaining({ id: owned.artifactId }),
    );
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: kind === "user" ? "user.deleted" : "organization.deleted",
      data: { id: kind === "user" ? owner.userId : owner.orgId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    await chat.requestArtifactCatalogEntry(owner, owned.artifactId, [404]);
    await expect(
      retainedHistoricalFileExists(owned.fileId),
    ).resolves.toBeFalsy();
    expect((await chat.listArtifactCatalog(outsider)).artifacts).toContainEqual(
      expect.objectContaining({ id: unrelated.artifactId }),
    );
    await expect(
      retainedHistoricalFileExists(unrelated.fileId),
    ).resolves.toBeTruthy();
  },
);
