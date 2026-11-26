import { userExportContract } from "@okouai/api-contracts/contracts/user-export";
import { createStore } from "ccstate";
import { strFromU8, unzipSync } from "fflate";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { userExportRoutes } from "../user-export";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { mockClerkUsers } from "./helpers/clerk-users";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const workflows = createWorkflowsBddApi(context);
const chatFiles = createChatFilesBddApi(context);
const exportsApi = setupApp({ context, routes: userExportRoutes })(
  userExportContract,
);

/** Clerk keeps each actor's real profile and workspace membership. */
async function seedMemberships(actors: readonly ApiTestUser[]) {
  mockClerkUsers(
    context,
    actors.map((actor) => {
      const emailId = `email_${actor.userId}`;
      return {
        id: actor.userId,
        emailAddresses: [{ id: emailId, emailAddress: actor.email }],
        primaryEmailAddressId: emailId,
      };
    }),
  );
  const memberships = createStore();
  await Promise.all(
    actors.map((actor) => {
      if (!actor.orgId) {
        throw new Error("expected a workspace member");
      }
      return memberships.set(
        seedOrgMembership$,
        { orgId: actor.orgId, userId: actor.userId },
        context.signal,
      );
    }),
  );
}

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function jsonEntry(files: Record<string, Uint8Array>, path: string): unknown {
  const bytes = files[path];
  if (!bytes) {
    throw new Error(`The export has no ${path}`);
  }
  return JSON.parse(strFromU8(bytes));
}

/** The owner's export request(s) are processed, optionally with workflow or thread content. */
async function ownerExport(options: {
  readonly concurrent: boolean;
  readonly includeWorkflow?: boolean;
  readonly includeThread?: boolean;
}) {
  const owner = bdd.user({ orgRole: "org:member" });
  const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
  const outsider = bdd.user({ orgRole: "org:member" });
  bdd.acceptStorageWrites();
  const storage = installDurableUserExportStorage(context, { prefixes: [""] });
  const instruction = "Summarize the exported workflow inputs.";
  const [workflowId, thread] = await Promise.all([
    options.includeWorkflow
      ? workflows.createWorkflow(owner, {
          name: "exported-workflow",
          visibility: "private",
          instruction,
        })
      : Promise.resolve(""),
    options.includeThread
      ? chatFiles.createThread(owner, { title: "Exported conversation" })
      : Promise.resolve({ id: "" }),
    seedMemberships([owner]),
  ]);

  const headers = signIn(owner);
  const started = options.concurrent
    ? await Promise.all([
        accept(exportsApi.post({ headers, body: undefined }), [202]),
        accept(exportsApi.post({ headers, body: undefined }), [202]),
      ])
    : [await accept(exportsApi.post({ headers, body: undefined }), [202])];
  await flushWaitUntilForTest();
  return {
    owner,
    peer,
    outsider,
    storage,
    instruction,
    workflowId,
    threadId: thread.id,
    started,
  };
}

test("user-export-publication-002 (1/5) deduplicates concurrent export requests into one completed job", async () => {
  const { owner, started } = await ownerExport({ concurrent: true });

  const status = await accept(
    exportsApi.get({ headers: signIn(owner) }),
    [200],
  );

  const [first, second] = started;
  expect(second?.body.jobId).toBe(first?.body.jobId);
  expect(status.body.job).toMatchObject({
    id: first?.body.jobId,
    status: "completed",
    error: null,
  });
});

test("user-export-publication-002 (2/5) publishes an owned ZIP containing the owner's workflow", async () => {
  const { owner, storage, instruction, workflowId, started } =
    await ownerExport({ concurrent: false, includeWorkflow: true });

  const status = await accept(
    exportsApi.get({ headers: signIn(owner) }),
    [200],
  );
  const downloadUrl = status.body.job?.downloadUrl;
  if (!downloadUrl) {
    throw new Error("The completed export has no download URL");
  }
  const files = unzipSync(storage.download(downloadUrl));

  expect(status.body.job).toMatchObject({
    id: started[0]?.body.jobId,
    status: "completed",
    error: null,
  });
  expect(jsonEntry(files, `workflows/${workflowId}.json`)).toMatchObject({
    instruction,
  });
});

test("user-export-publication-002 (3/5) publishes an owned ZIP containing the owner's chat thread", async () => {
  const { owner, storage, threadId, started } = await ownerExport({
    concurrent: false,
    includeThread: true,
  });

  const status = await accept(
    exportsApi.get({ headers: signIn(owner) }),
    [200],
  );
  const downloadUrl = status.body.job?.downloadUrl;
  if (!downloadUrl) {
    throw new Error("The completed export has no download URL");
  }
  const files = unzipSync(storage.download(downloadUrl));

  expect(status.body.job).toMatchObject({
    id: started[0]?.body.jobId,
    status: "completed",
    error: null,
  });
  expect(jsonEntry(files, `chat-threads/${threadId}.json`)).toMatchObject({
    title: "Exported conversation",
  });
});

test("user-export-publication-002 (4/5) hides the export from a same-workspace peer and an outsider", async () => {
  const { peer, outsider } = await ownerExport({ concurrent: false });

  const peerStatus = await accept(
    exportsApi.get({ headers: signIn(peer) }),
    [200],
  );
  const outsiderStatus = await accept(
    exportsApi.get({ headers: signIn(outsider) }),
    [200],
  );

  expect(peerStatus.body.job).toBeNull();
  expect(outsiderStatus.body.job).toBeNull();
});

test("user-export-publication-002 (5/5) rate-limits another export request from the owner", async () => {
  const { owner } = await ownerExport({ concurrent: false });

  const again = await accept(
    exportsApi.post({ headers: signIn(owner), body: undefined }),
    [429],
  );

  expect(again.body.error.code).toBe("RATE_LIMITED");
});
