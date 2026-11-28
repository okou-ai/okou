import { randomUUID } from "node:crypto";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { GOOGLE_WORKSPACE_MIME_TYPES } from "@okouai/core/google-workspace-conversion";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadsArtifactsSyncRoutes } from "../chat-threads-artifacts-sync";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGoogleDriveArtifactUpload,
  mockGoogleDriveConnectorOAuth,
  mockGoogleDriveFilesList,
} from "./helpers/api-bdd-connectors";
import { okouTokenFromExecution } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createRouteMocks } from "./helpers/route-test";
import { createChatConnectorAccessApi } from "./helpers/chat-connector-access";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const callbacks = createChatCallbacksApi(context);
const connectors = createConnectorBddApi(context);
const mocks = createRouteMocks(context);

function headers(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function catalog() {
  return setupApp({ context, routes: artifactCatalogRoutes })(
    artifactCatalogContract,
  );
}

async function uploadedArtifact() {
  const owner = await publicChatActor(context);
  const run = await owner.sendChatRun(owner.actor, {
    prompt: "Create an artifact for lazy Drive status",
  });
  const execution = await owner.runExecution(run.runId);
  const fileId = randomUUID();
  const storage = callbacks.acceptChatObjectStorage();
  storage.addObject({
    bucket: "test-user-artifacts",
    key: `artifacts/${owner.actor.userId}/${fileId}/report.csv`,
    size: 64,
  });
  await chat.completeUploadWithBearer(
    `Bearer ${okouTokenFromExecution(execution.execution)}`,
    { id: fileId },
    [200],
  );
  const artifactId = await chat.resolveCatalogArtifactId(
    owner.actor,
    run.threadId,
    fileId,
  );
  return {
    owner,
    run,
    fileId,
    artifactId,
    runToken: okouTokenFromExecution(execution.execution),
  };
}

async function connectDrive(actor: ApiTestUser) {
  mockGoogleDriveConnectorOAuth();
  const started = await connectors.startOauth(actor, "google-drive", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  await connectors.completeOauthCallback("google-drive", {
    code: "drive-ok",
    state,
  });
  return await connectors.readDefaultBuiltinAccount(actor, "google-drive");
}

describe("artifact catalog lazy Drive detail metadata", () => {
  it("keeps list and context-free detail provider-free and respects Chat access", async () => {
    const { owner, run, artifactId } = await uploadedArtifact();
    const { actor } = owner;
    const connection = await connectDrive(actor);
    const access = createChatConnectorAccessApi(context);
    const selection = {
      target: { kind: "builtin", connectorSlug: "google-drive" },
      connectionId: connection.id,
    } as const;
    const provider = mockGoogleDriveFilesList(() => {
      return { status: 200, files: [] };
    });

    const list = await accept(
      catalog().list({
        headers: headers(actor),
        query: { chatThreadId: run.threadId },
      }),
      [200],
    );
    expect(list.body.artifacts).toContainEqual(
      expect.objectContaining({ id: artifactId }),
    );
    expect(list.body.artifacts[0]).not.toHaveProperty("googleDriveSync");
    const plain = await accept(
      catalog().get({ headers: headers(actor), params: { artifactId } }),
      [200],
    );
    expect(plain.body).not.toHaveProperty("googleDriveSync");
    expect(plain.body).not.toHaveProperty("googleDriveConnectionId");
    expect(provider.queries).toStrictEqual([]);

    await access.setThreadOverride(actor, run.threadId, selection, false);
    const unauthorized = await accept(
      catalog().get({
        headers: headers(actor),
        params: { artifactId },
        query: { chatThreadId: run.threadId },
      }),
      [200],
    );
    expect(unauthorized.body.googleDriveSync).toStrictEqual({
      status: "disconnected",
      recovery: { action: "unavailable" },
    });
    expect(provider.queries).toStrictEqual([]);

    await access.setThreadOverride(actor, run.threadId, selection, true);
    const ready = await accept(
      catalog().get({
        headers: headers(actor),
        params: { artifactId },
        query: { chatThreadId: run.threadId },
      }),
      [200],
    );
    expect(ready.body.googleDriveConnectionId).toBe(connection.id);
    expect(ready.body.googleDriveSync).toStrictEqual({
      status: "not_synced",
    });
    expect(provider.queries).toHaveLength(1);
  });

  it("uses exact upload identity across owned view threads and retains original plus conversion state", async () => {
    const { owner, run, artifactId, fileId, runToken } =
      await uploadedArtifact();
    const { actor } = owner;
    const defaultAccount = await connectDrive(actor);
    mockGoogleDriveConnectorOAuth({
      userInfo: {
        id: "detail-selected-user",
        email: "detail-selected@example.test",
        name: "Detail selected Drive",
      },
    });
    const selectedStart = await connectors.startOauth(
      actor,
      "google-drive",
      "oauth",
      { intent: "add", displayName: "Detail selected Drive" },
    );
    const selectedState = new URL(
      selectedStart.authorizationUrl,
    ).searchParams.get("state");
    if (!selectedState) {
      throw new Error("Expected selected account OAuth state");
    }
    await connectors.completeOauthCallback("google-drive", {
      code: "drive-selected",
      state: selectedState,
    });
    const accounts = await connectors.listBuiltinConnectorAccounts(
      actor,
      "google-drive",
    );
    const connection = accounts.find((account) => {
      return account.externalEmail === "detail-selected@example.test";
    });
    if (!connection) {
      throw new Error("Expected selected Drive connection");
    }
    const view = await chat.createThread(actor, { model: null });
    await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadConnectorSelectionContract,
      ).update({
        headers: headers(actor),
        params: { id: view.id },
        body: {
          connectionId: connection.id,
          target: { kind: "builtin", connectorSlug: "google-drive" },
        },
      }),
      [200],
    );
    const provider = mockGoogleDriveFilesList(() => {
      return {
        status: 200,
        files: [
          {
            id: "original-copy",
            name: "report.csv",
            appProperties: { vm0RunId: run.runId, vm0FileId: fileId },
          },
          {
            id: "converted-copy",
            name: "report",
            mimeType: GOOGLE_WORKSPACE_MIME_TYPES.spreadsheet,
            webViewLink:
              "https://docs.google.com/spreadsheets/d/converted-copy/edit",
            appProperties: { vm0RunId: run.runId, vm0FileId: fileId },
          },
          {
            id: "wrong-catalog-identity",
            name: "unrelated",
            appProperties: { vm0RunId: run.runId, vm0FileId: artifactId },
          },
        ],
      };
    });
    const detail = await accept(
      catalog().get({
        headers: headers(actor),
        params: { artifactId },
        query: { chatThreadId: view.id },
      }),
      [200],
    );
    expect(detail.body.googleDriveConnectionId).toBe(connection.id);
    expect(detail.body.googleDriveSync).toStrictEqual({
      status: "synced",
      originalUploaded: true,
      id: "converted-copy",
      name: "report",
      mimeType: GOOGLE_WORKSPACE_MIME_TYPES.spreadsheet,
      webViewLink: "https://docs.google.com/spreadsheets/d/converted-copy/edit",
    });
    expect(provider.queries).toHaveLength(1);
    expect(provider.queries[0]).toContain(
      `key='vm0FileId' and value='${fileId}'`,
    );
    expect(provider.queries[0]).not.toContain(view.id);
    expect(provider.queries[0]).not.toContain(artifactId);
    expect(provider.authorizationHeaders).toStrictEqual([
      "Bearer drive-access-drive-selected",
    ]);

    const upload = setupApp({
      context,
      routes: chatThreadsArtifactsSyncRoutes,
    })(artifactGoogleDriveContract);
    const uploaded = mockGoogleDriveArtifactUpload({
      id: "selected-upload",
      name: "report.csv",
    });
    const request = {
      params: { artifactId },
      body: {
        chatThreadId: view.id,
        connectionId: connection.id,
        mode: "original" as const,
      },
    };
    await accept(
      upload.uploadFromChat({
        ...request,
        headers: { authorization: `Bearer ${runToken}` },
      }),
      [400],
    );
    const conflicting = await accept(
      upload.uploadFromChat({
        ...request,
        headers: headers(actor),
        body: { ...request.body, connectionId: defaultAccount.id },
      }),
      [400],
    );
    expect(conflicting.body.error.message).toBe(
      "Google Drive account is unavailable in this Chat",
    );
    expect(uploaded.folderQueries).toHaveLength(0);

    const response = await accept(
      upload.uploadFromChat({ ...request, headers: headers(actor) }),
      [200],
    );
    expect(response.body.id).toBe("selected-upload");
    expect(uploaded.authorizationHeaders).toContain(
      "Bearer drive-access-drive-selected",
    );

    const currentRun = await owner.sendChatRun(actor, {
      threadId: view.id,
      prompt: "Export the owned artifact from this Chat",
    });
    const currentExecution = await owner.runExecution(currentRun.runId);
    await accept(
      upload.uploadFromChat({
        ...request,
        headers: {
          authorization: `Bearer ${okouTokenFromExecution(currentExecution.execution)}`,
        },
      }),
      [200],
    );

    const access = createChatConnectorAccessApi(context);
    const target = { kind: "builtin", connectorSlug: "google-drive" } as const;
    for (const account of accounts) {
      await access.setThreadOverride(
        actor,
        view.id,
        { target, connectionId: account.id },
        false,
      );
    }
    const denied = await accept(
      catalog().get({
        headers: headers(actor),
        params: { artifactId },
        query: { chatThreadId: view.id },
      }),
      [200],
    );
    expect(denied.body.googleDriveSync).toStrictEqual({
      status: "disconnected",
      recovery: { action: "unavailable" },
    });
    await accept(
      upload.uploadFromChat({ ...request, headers: headers(actor) }),
      [400],
    );
    expect(uploaded.bodies).toHaveLength(2);
  });

  it("persists OAuth refresh and terminal reconnect through detail polling", async () => {
    const { owner, run, artifactId } = await uploadedArtifact();
    const { actor } = owner;
    const connection = await connectDrive(actor);
    const refresh = mockGoogleDriveConnectorOAuth({
      refreshOutcome: { type: "ok", accessToken: "detail-refreshed" },
    });
    const provider = mockGoogleDriveFilesList((request) => {
      return request.headers.get("authorization") === "Bearer detail-refreshed"
        ? { status: 200, files: [] }
        : { status: 401 };
    });
    for (let poll = 0; poll < 2; poll += 1) {
      const detail = await accept(
        catalog().get({
          headers: headers(actor),
          params: { artifactId },
          query: { chatThreadId: run.threadId },
        }),
        [200],
      );
      expect(detail.body.googleDriveSync).toStrictEqual({
        status: "not_synced",
      });
    }
    expect(refresh.refreshBodies).toHaveLength(1);
    expect(provider.authorizationHeaders).toStrictEqual([
      "Bearer drive-access-drive-ok",
      "Bearer detail-refreshed",
      "Bearer detail-refreshed",
    ]);
    const terminal = mockGoogleDriveConnectorOAuth();
    const failed = mockGoogleDriveFilesList(() => {
      return { status: 401 };
    });
    for (let poll = 0; poll < 2; poll += 1) {
      const detail = await accept(
        catalog().get({
          headers: headers(actor),
          params: { artifactId },
          query: { chatThreadId: run.threadId },
        }),
        [200],
      );
      expect(detail.body.googleDriveConnectionId).toBe(connection.id);
      expect(detail.body.googleDriveSync).toStrictEqual({
        status: "disconnected",
        recovery: { action: "reconnect", connectionId: connection.id },
      });
    }
    expect(terminal.refreshBodies).toHaveLength(1);
    expect(failed.queries).toHaveLength(1);
    await expect(
      connectors.readDefaultBuiltinAccount(actor, "google-drive"),
    ).resolves.toMatchObject({ connectionStatus: "reconnect-required" });
  });

  it("rejects non-owned or missing context and independently rejects non-owned resources before provider access", async () => {
    const { owner, run, artifactId } = await uploadedArtifact();
    const { actor } = owner;
    await connectDrive(actor);
    const peer = bdd.user({ orgId: actor.orgId });
    const peerThread = await chat.createThread(peer, {
      model: null,
    });
    const provider = mockGoogleDriveFilesList(() => {
      return { status: 200, files: [] };
    });
    for (const chatThreadId of [peerThread.id, randomUUID()]) {
      const denied = await accept(
        catalog().get({
          headers: headers(actor),
          params: { artifactId },
          query: { chatThreadId },
        }),
        [404],
      );
      expect(denied.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    }
    await accept(
      catalog().get({
        headers: headers(peer),
        params: { artifactId },
        query: { chatThreadId: peerThread.id },
      }),
      [404],
    );
    await accept(
      catalog().get({
        headers: headers(bdd.user()),
        params: { artifactId },
        query: { chatThreadId: run.threadId },
      }),
      [404],
    );
    expect(provider.queries).toStrictEqual([]);
  });
});
