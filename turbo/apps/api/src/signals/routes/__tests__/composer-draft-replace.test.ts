import { randomUUID } from "node:crypto";

import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
  type ComposerDraft,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { projectChatContract } from "@okouai/api-contracts/contracts/project-chat";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { agentDraftRoutes, projectAgentDraftRoutes } from "../agent-draft";
import { chatThreadDraftGetRoutes } from "../chat-threads-draft-get";
import { chatThreadDraftReplaceRoutes } from "../chat-threads-draft-replace";
import { chatThreadPatchRoutes } from "../chat-threads-patch";
import { projectChatRoutes } from "../project-chat";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const routes = Object.freeze([
  ...agentDraftRoutes,
  ...chatThreadDraftGetRoutes,
  ...chatThreadDraftReplaceRoutes,
  ...chatThreadPatchRoutes,
  ...projectAgentDraftRoutes,
  ...projectChatRoutes,
]);
const empty = Object.freeze({ draftUserMessage: null, draftAttachments: null });
type Kind = "agent" | "thread";
interface Fixture {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly threadId: string;
}

async function fixture(actor = bdd.user()): Promise<Fixture> {
  const agent = await chat.createAgentForChatThread(actor);
  const thread = await chat.createThread(actor, { agentId: agent.agentId });
  await enableConditionalDrafts(actor);
  return { actor, agentId: agent.agentId, threadId: thread.id };
}

async function enableConditionalDrafts(actor: ApiTestUser, enabled = true) {
  if (!actor.orgId) throw new Error("Expected an organization");
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    {
      [FeatureSwitchKey.ConditionalComposerDrafts]: enabled,
    },
  );
}

function headers(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function target(kind: Kind, value: Fixture) {
  return { id: kind === "agent" ? value.agentId : value.threadId };
}

function textDraft(text: string): ComposerDraft {
  return {
    draftUserMessage: { version: 1, parts: [{ type: "text", text }] },
    draftAttachments: null,
  };
}

function richDraft() {
  const attachment = {
    id: randomUUID(),
    url: "https://files.example.com/original.txt",
    filename: "original.txt",
    contentType: "text/plain",
    size: 23,
  };
  const document: UserMessageInputDocument = {
    version: 1,
    parts: [
      { type: "text", text: "A Web draft" },
      {
        type: "file",
        fileId: attachment.id,
        filenameSnapshot: attachment.filename,
        contentType: attachment.contentType,
      },
      {
        type: "feedback",
        quote: "A Web draft",
        note: [{ type: "text", text: "Keep this context." }],
        eventId: "feedback-event",
        range: { start: 0, end: 11 },
      },
    ],
  };
  return { draftUserMessage: document, draftAttachments: [attachment] };
}

async function read(kind: Kind, value: Fixture): Promise<ComposerDraft> {
  const args = { params: target(kind, value), headers: headers(value.actor) };
  const client = setupApp({ context, routes });
  const response = await accept(
    kind === "agent"
      ? client(agentDraftContract).get(args)
      : client(chatThreadDraftContract).get(args),
    [200],
  );
  return response.body;
}

async function patch(kind: Kind, value: Fixture, body: ComposerDraft) {
  const args = {
    params: target(kind, value),
    headers: headers(value.actor),
    body,
  };
  const client = setupApp({ context, routes });
  await accept(
    kind === "agent"
      ? client(agentDraftContract).patch(args)
      : client(chatThreadByIdContract).patch(args),
    [204],
  );
}

async function replace(
  kind: Kind,
  value: Fixture,
  expected: ComposerDraft,
  draft: ComposerDraft,
) {
  const args = {
    params: target(kind, value),
    headers: headers(value.actor),
    body: { expected, draft },
  };
  const client = setupApp({ context, routes });
  return await accept(
    kind === "agent"
      ? client(agentDraftContract).replace(args)
      : client(chatThreadDraftContract).replace(args),
    [204, 409],
  );
}

describe.each<Kind>(["agent", "thread"])("conditional %s drafts", (kind) => {
  it("contains only the new method when its rollout switch is disabled", async () => {
    const value = await fixture();
    const saved = richDraft();
    await patch(kind, value, saved);
    await enableConditionalDrafts(value.actor, false);
    const args = {
      params: target(kind, value),
      headers: headers(value.actor),
      body: { expected: saved, draft: empty },
    };
    const client = setupApp({ context, routes });
    await accept(
      kind === "agent"
        ? client(agentDraftContract).replace(args)
        : client(chatThreadDraftContract).replace(args),
      [404],
    );
    await expect(read(kind, value)).resolves.toStrictEqual(saved);
    const legacy = textDraft("Legacy PATCH stays available");
    await patch(kind, value, legacy);
    await expect(read(kind, value)).resolves.toStrictEqual(legacy);
  });

  it("requires authentication even with a matching expected value", async () => {
    const value = await fixture();
    const saved = richDraft();
    await patch(kind, value, saved);
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      toAuth: () => {
        return { userId: null, orgId: null };
      },
    });
    const args = {
      params: target(kind, value),
      headers: {},
      body: { expected: saved, draft: empty },
    };
    const client = setupApp({ context, routes });
    await accept(
      kind === "agent"
        ? client(agentDraftContract).replace(args)
        : client(chatThreadDraftContract).replace(args),
      [401],
    );
    await expect(read(kind, value)).resolves.toStrictEqual(saved);
  });

  it("creates, replaces and clears through the existing canonical reader", async () => {
    const value = await fixture();
    await expect(read(kind, value)).resolves.toStrictEqual(empty);
    expect((await replace(kind, value, empty, empty)).status).toBe(204);
    const first = richDraft();
    expect((await replace(kind, value, empty, first)).status).toBe(204);
    await expect(read(kind, value)).resolves.toStrictEqual(first);
    const next = textDraft("An explicitly chosen replacement\n你好");
    expect((await replace(kind, value, first, next)).status).toBe(204);
    await expect(read(kind, value)).resolves.toStrictEqual(next);
    expect((await replace(kind, value, next, empty)).status).toBe(204);
    await expect(read(kind, value)).resolves.toStrictEqual(empty);
  });

  it("allows one winner for both concurrent creation and replacement", async () => {
    const value = await fixture();
    let expected: ComposerDraft = empty;
    for (const suffix of ["first writes", "replacements"]) {
      const a = textDraft(`Client A ${suffix}`);
      const b = textDraft(`Client B ${suffix}`);
      const [left, right] = await Promise.all([
        replace(kind, value, expected, a),
        replace(kind, value, expected, b),
      ]);
      expect([left.status, right.status].sort()).toStrictEqual([204, 409]);
      expected = left.status === 204 ? a : b;
      await expect(read(kind, value)).resolves.toStrictEqual(expected);
    }
  });

  it("preserves newer Web rich content against stale save and clear requests", async () => {
    const value = await fixture();
    const base = textDraft("The native client's earlier snapshot");
    await patch(kind, value, base);
    const observed = await read(kind, value);
    const web = richDraft();
    await patch(kind, value, web);

    const conflict = await replace(
      kind,
      value,
      observed,
      textDraft("Stale text"),
    );
    expect(conflict.status).toBe(409);
    if (conflict.status === 409) {
      expect(conflict.body.error.code).toBe("CONFLICT");
    }
    expect((await replace(kind, value, observed, empty)).status).toBe(409);
    expect((await replace(kind, value, empty, empty)).status).toBe(409);
    expect(
      (await replace(kind, value, empty, textDraft("Stale first save"))).status,
    ).toBe(409);
    await expect(read(kind, value)).resolves.toStrictEqual(web);
  });

  it("compares all attachment metadata even when the document is unchanged", async () => {
    const value = await fixture();
    const base = richDraft();
    await patch(kind, value, base);
    const newer = {
      ...base,
      draftAttachments: base.draftAttachments.map((file) => {
        return {
          ...file,
          url: "https://files.example.com/refreshed.txt",
        };
      }),
    };
    await patch(kind, value, newer);
    expect(
      (await replace(kind, value, base, textDraft("Old attachment"))).status,
    ).toBe(409);
    await expect(read(kind, value)).resolves.toStrictEqual(newer);
    expect((await replace(kind, value, newer, empty)).status).toBe(204);
    await expect(read(kind, value)).resolves.toStrictEqual(empty);
  });

  it("does not recreate a deleted draft from a stale nonempty expectation", async () => {
    const value = await fixture();
    const base = richDraft();
    await patch(kind, value, base);
    await patch(kind, value, empty);
    expect(
      (await replace(kind, value, base, textDraft("Late save"))).status,
    ).toBe(409);
    expect((await replace(kind, value, base, empty)).status).toBe(409);
    await expect(read(kind, value)).resolves.toStrictEqual(empty);
  });

  it("does not borrow another target's expected value", async () => {
    const first = await fixture();
    const second = await fixture(first.actor);
    const base = textDraft("Only the first target");
    await patch(kind, first, base);
    expect(
      (await replace(kind, second, base, textDraft("Wrong target"))).status,
    ).toBe(409);
    await expect(read(kind, first)).resolves.toStrictEqual(base);
    await expect(read(kind, second)).resolves.toStrictEqual(empty);
  });

  it("rejects missing expectations, partial snapshots and invalid rich payloads", async () => {
    const value = await fixture();
    const saved = richDraft();
    await patch(kind, value, saved);
    const raw = setupRawAppRequest({ context, routes });
    const path =
      kind === "agent"
        ? `/api/agents/${value.agentId}/draft`
        : `/api/chat-threads/${value.threadId}/draft`;
    for (const body of [
      { draft: empty },
      { expected: { draftUserMessage: saved.draftUserMessage }, draft: empty },
    ]) {
      const response = await raw(path, {
        method: "PUT",
        headers: {
          ...headers(value.actor),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    // The TypeScript contract can express this cross-field validation error.
    // Only missing/partial request shapes above need the raw request helper.
    const args = {
      params: target(kind, value),
      headers: headers(value.actor),
      body: {
        expected: saved,
        draft: {
          draftUserMessage: null,
          draftAttachments: saved.draftAttachments,
        },
      },
    };
    const client = setupApp({ context, routes });
    await accept(
      kind === "agent"
        ? client(agentDraftContract).replace(args)
        : client(chatThreadDraftContract).replace(args),
      [400],
    );
    await expect(read(kind, value)).resolves.toStrictEqual(saved);
  });
});

describe("conditional draft authorization and aliases", () => {
  it("does not expose or overwrite an agent draft from another organization", async () => {
    const value = await fixture();
    const saved = richDraft();
    await patch("agent", value, saved);
    const foreign = bdd.user();
    await enableConditionalDrafts(foreign);
    const client = setupApp({ context, routes })(agentDraftContract);
    const denied = await accept(
      client.replace({
        params: { id: value.agentId },
        headers: headers(foreign),
        body: { expected: saved, draft: empty },
      }),
      [404],
    );
    expect(denied.status).toBe(404);
    await expect(read("agent", value)).resolves.toStrictEqual(saved);
  });

  it("preserves the existing thread draft's private caller-key semantics", async () => {
    const value = await fixture();
    const saved = textDraft("Owner's draft");
    await patch("thread", value, saved);
    const foreign = { ...value, actor: bdd.user({ orgId: value.actor.orgId }) };
    await enableConditionalDrafts(foreign.actor);
    const other = textDraft("Other caller's private draft");
    expect((await replace("thread", foreign, empty, other)).status).toBe(204);
    await expect(read("thread", foreign)).resolves.toStrictEqual(other);
    await expect(read("thread", value)).resolves.toStrictEqual(saved);
  });

  it("keeps submission and explicit Web clearing separate from a late save", async () => {
    const value = await fixture();
    const saved = textDraft("A submitted draft");
    await patch("thread", value, saved);
    await chat.requestSendEvent(
      value.actor,
      {
        agentId: value.agentId,
        threadId: value.threadId,
        prompt: "A submitted draft",
        clientEventId: randomUUID(),
      },
      [201],
    );
    // Sending does not own draft clearing. Web explicitly clears its saved
    // draft alongside the send; a delayed writer must respect that clear.
    await expect(read("thread", value)).resolves.toStrictEqual(saved);
    await patch("thread", value, empty);
    await expect(read("thread", value)).resolves.toStrictEqual(empty);
    expect(
      (await replace("thread", value, saved, textDraft("Delayed save"))).status,
    ).toBe(409);
    await expect(read("thread", value)).resolves.toStrictEqual(empty);
  });

  it.each<Kind>(["agent", "thread"])(
    "shares the %s resource with Project aliases and retains their feature gate",
    async (kind) => {
      const value = await fixture();
      if (!value.actor.orgId) throw new Error("Expected an organization");
      const actor = { ...value.actor, orgId: value.actor.orgId };
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.SingleAgent]: true,
      });
      const saved = richDraft();
      await patch(kind, value, saved);
      const client = setupApp({ context, routes })(projectChatContract);
      const args = {
        params: target(kind, value),
        headers: headers(actor),
        body: { expected: saved, draft: textDraft("Project alias edit") },
      };
      await accept(
        kind === "agent"
          ? client.replaceAgentDraft(args)
          : client.replaceDraft(args),
        [204],
      );
      await expect(read(kind, value)).resolves.toStrictEqual(args.body.draft);
      const web = richDraft();
      await patch(kind, value, web);
      await accept(
        kind === "agent"
          ? client.replaceAgentDraft(args)
          : client.replaceDraft(args),
        [409],
      );
      await expect(read(kind, value)).resolves.toStrictEqual(web);
      await enableConditionalDrafts(actor, false);
      const disabled = {
        ...args,
        headers: headers(actor),
        body: { expected: web, draft: empty },
      };
      await accept(
        kind === "agent"
          ? client.replaceAgentDraft(disabled)
          : client.replaceDraft(disabled),
        [404],
      );
      await expect(read(kind, value)).resolves.toStrictEqual(web);
      await enableConditionalDrafts(actor);
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.SingleAgent]: false,
      });
      await accept(
        kind === "agent"
          ? client.replaceAgentDraft({ ...args, headers: headers(actor) })
          : client.replaceDraft({ ...args, headers: headers(actor) }),
        [404],
      );
      await expect(read(kind, value)).resolves.toStrictEqual(web);
    },
  );

  it("rejects the Project alias when the thread belongs to another caller", async () => {
    const value = await fixture();
    const saved = richDraft();
    await patch("thread", value, saved);
    const foreign = bdd.user({ orgId: value.actor.orgId });
    await enableConditionalDrafts(foreign);
    if (!foreign.orgId) throw new Error("Expected an organization");
    await updateFeatureSwitchesForUser(
      context,
      { ...foreign, orgId: foreign.orgId },
      {
        [FeatureSwitchKey.SingleAgent]: true,
      },
    );
    const client = setupApp({ context, routes })(projectChatContract);
    await accept(
      client.replaceDraft({
        params: { id: value.threadId },
        headers: headers(foreign),
        body: { expected: saved, draft: empty },
      }),
      [404],
    );
    await expect(read("thread", value)).resolves.toStrictEqual(saved);
  });
});
