import { randomUUID } from "node:crypto";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { GOOGLE_WORKSPACE_MIME_TYPES } from "@okouai/core/google-workspace-conversion";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { chatThreadRoutes } from "../chat-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGoogleDriveConnectorOAuth,
  mockGoogleDriveFilesList,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const callbacks = createChatCallbacksApi(context);
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);
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
    agentId: owner.agentId,
    prompt: "Create an artifact for lazy Drive status",
  });
  const claimed = await owner.claimChatRun(owner.runnerGroup, run.runId);
  const fileId = randomUUID();
  const storage = callbacks.acceptChatObjectStorage();
  storage.addObject({
    bucket: "test-user-artifacts",
    key: `artifacts/${owner.actor.userId}/${fileId}/report.csv`,
    size: 64,
  });
  await chat.completeUploadWithBearer(
    `Bearer ${okouTokenFromClaim(claimed.claim)}`,
    { id: fileId },
    [200],
  );
  const artifactId = await chat.resolveCatalogArtifactId(
    owner.actor,
    run.threadId,
    fileId,
  );
  return { owner, run, fileId, artifactId };
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
  it("keeps list and context-free detail provider-free and respects agent grants", async () => {
    const { owner, run, artifactId } = await uploadedArtifact();
    const { actor, agentId } = owner;
    const connection = await connectDrive(actor);
    const provider = mockGoogleDriveFilesList(() => {
      return { status: 200, files: [] };
    });
    await runs.enableAgentConnectors(actor, agentId, ["google-drive"]);

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

    await runs.enableAgentConnectors(actor, agentId, []);
    const unauthorized = await accept(
      catalog().get({
        headers: headers(actor),
        params: { artifactId },
        query: { chatThreadId: run.threadId },
      }),
      [200],
    );
    expect(unauthorized.body.googleDriveConnectionId).toBe(connection.id);
    expect(unauthorized.body.googleDriveSync).toStrictEqual({
      status: "disconnected",
      recovery: { action: "authorize" },
    });
    expect(provider.queries).toStrictEqual([]);

    await runs.enableAgentConnectors(actor, agentId, ["google-drive"]);
    const ready = await accept(
      catalog().get({
        headers: headers(actor),
        params: { artifactId },
        query: { chatThreadId: run.threadId },
      }),
      [200],
    );
    expect(ready.body.googleDriveSync).toStrictEqual({
      status: "not_synced",
      accountReady: true,
    });
    expect(provider.queries).toHaveLength(1);
  });

  it("uses exact upload identity across owned view threads and retains original plus conversion state", async () => {
    const { owner, run, artifactId, fileId } = await uploadedArtifact();
    const { actor, agentId } = owner;
    await connectDrive(actor);
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
      undefined,
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
    await runs.enableAgentConnectors(actor, agentId, ["google-drive"]);
    const view = await chat.createThread(actor, { agentId, model: null });
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
      accountReady: true,
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
    expect(provider.queries[0]).toContain(run.runId);
    expect(provider.queries[0]).not.toContain(view.id);
    expect(provider.queries[0]).not.toContain(artifactId);
    expect(provider.authorizationHeaders).toStrictEqual([
      "Bearer drive-access-drive-selected",
    ]);
  });

  it("persists OAuth refresh and terminal reconnect through detail polling", async () => {
    const { owner, run, artifactId } = await uploadedArtifact();
    const { actor, agentId } = owner;
    const connection = await connectDrive(actor);
    await runs.enableAgentConnectors(actor, agentId, ["google-drive"]);
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
        accountReady: true,
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
    const { actor, agentId } = owner;
    await connectDrive(actor);
    await runs.enableAgentConnectors(actor, agentId, ["google-drive"]);
    const peer = bdd.user({ orgId: actor.orgId });
    const peerAgent = await bdd.createAgent(peer, {
      displayName: "Peer context",
      visibility: "private",
    });
    const peerThread = await chat.createThread(peer, {
      agentId: peerAgent.agentId,
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
