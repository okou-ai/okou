import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { createStore } from "ccstate";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  transferAgentOwnerFixture,
} from "../../../test-fixtures/account-erasure-subject";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import {
  holdChatThreadEventIdFixture,
  setChatThreadAgentFixture,
  withChatThreadContentBarrierFixture,
} from "../../../test-fixtures/chat-thread-content-erasure";
import {
  readUnrepairedOrgModelPolicyFixture,
  stageUnrepairedOrgModelPolicyFixture,
} from "../../../test-fixtures/org-model-policies";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const api = createRunsApi(context);
const BLOCKED = { interval: 10, timeout: 10_000 } as const;

const POLICY_MODELS = ["claude-sonnet-5", "claude-opus-4-8"] as const;

interface SettingsFixture {
  readonly actor: ApiTestUser;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
}

/** Creates an org route, an Agent and a pinned chat thread through the
 * product routes, so every later settings write is an ordinary client write. */
async function createSettingsFixture(title: string): Promise<SettingsFixture> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const { providerId } = await api.ensureOrgModelProvider(actor);
  await api.updateOrgModelPolicies(
    actor,
    POLICY_MODELS.map((model) => {
      return {
        model,
        isDefault: model === "claude-sonnet-5",
        defaultProviderType: "anthropic-api-key" as const,
        credentialScope: "org" as const,
        modelProviderId: providerId,
      };
    }),
  );
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat thread model settings agent",
    visibility: "private",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title,
    model: "claude-sonnet-5",
  });
  const { orgId } = actor;
  if (!orgId) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  await store.set(
    seedOrgMembership$,
    { orgId, userId: actor.userId },
    context.signal,
  );
  return {
    actor,
    userId: actor.userId,
    orgId,
    agentId: agent.agentId,
    threadId: thread.id,
  };
}

/** Projects one dormant B1 closure and retires it with the test. */
function closeSubject(
  subject: ErasureSubject,
): Promise<{ readonly jobId: string }> {
  const closing = closeErasureSubjectFixture(subject);
  onTestFinished(async () => {
    const { jobId } = await closing;
    await removeErasureSubjectsFixture([jobId]);
  });
  return closing;
}

interface SettingsEvent {
  readonly seqId: number;
  readonly kind: string;
}

function isSettingsEventKind(kind: string): boolean {
  return kind === "model_selection_updated" || kind === "service_tier_updated";
}

async function readEventPage(fixture: SettingsFixture) {
  const response = await chat.requestThreadEvents(fixture.actor, {}, [200]);
  if (!("events" in response.body)) {
    throw new Error("Expected the sidebar event page");
  }
  return response.body.events;
}

/** The thread's own durable settings events, as a sidebar client reads them.
 * One accepted update appends the model event and the service-tier event, so
 * it consumes exactly two sequence ids. */
async function settingsEvents(
  fixture: SettingsFixture,
): Promise<readonly SettingsEvent[]> {
  return (await readEventPage(fixture))
    .filter((event) => {
      return (
        isSettingsEventKind(event.kind) &&
        event.chatThreadId === fixture.threadId
      );
    })
    .map((event) => {
      return { seqId: event.seqId, kind: event.kind };
    });
}

/** Every sidebar event id this actor can read, including the client-supplied
 * ids both settings events carry. */
async function eventIds(fixture: SettingsFixture): Promise<readonly string[]> {
  return (await readEventPage(fixture)).map((event) => {
    return event.id;
  });
}

/** The last sequence id this actor's sidebar stream has consumed, whichever
 * event kind consumed it, so a denied write is measured against the whole
 * durable sequence rather than only its own kinds. */
async function lastStreamSeqId(fixture: SettingsFixture): Promise<number> {
  const seqId = (await readEventPage(fixture)).at(-1)?.seqId;
  if (seqId === undefined) {
    throw new Error("Expected at least one durable thread event");
  }
  return seqId;
}

/** The model pin, its per-model efforts and the service tier a production
 * metadata reader returns. */
async function readSettings(fixture: SettingsFixture): Promise<{
  readonly selectedModel: string | null;
  readonly modelSettings: unknown;
  readonly serviceTier: string | null;
}> {
  const metadata = await chat.readThreadMetadata(
    fixture.actor,
    fixture.threadId,
  );
  return {
    selectedModel: metadata.selectedModel,
    modelSettings: metadata.modelSettings,
    serviceTier: metadata.serviceTier,
  };
}

async function enableEffort(fixture: SettingsFixture): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.Effort]: true,
  });
}

/**
 * Documented external-behavior exception, shared with `model-policies.test.ts`.
 * An uninitialized or default-less `org_model_policies` state cannot be built
 * through the production interface: `PUT /api/model-policies` is a replace that
 * always requires a default and cannot leave the organization with none, and
 * `GET /api/model-policies` calls `ensureOrgModelPolicies` itself, so reading it
 * repairs the very state under test. The case is still worth testing because
 * this route's hidden policy bootstrap is exactly what a closed account must not
 * be able to reach, and the seeded rows are its only durable evidence.
 */
async function policyDefaults(
  fixture: SettingsFixture,
): Promise<readonly string[]> {
  const { policies } = await readUnrepairedOrgModelPolicyFixture(fixture.orgId);
  return policies
    .filter((policy) => {
      return policy.isDefault;
    })
    .map((policy) => {
      return policy.model;
    });
}

async function policyModels(
  fixture: SettingsFixture,
): Promise<readonly string[]> {
  const { policies } = await readUnrepairedOrgModelPolicyFixture(fixture.orgId);
  return policies.map((policy) => {
    return policy.model;
  });
}

describe("account erasure fences chat-thread model settings writes", () => {
  it("denies a model-selection update for a closed thread user and keeps the pin, effort and sidebar sequence", async () => {
    const fixture = await createSettingsFixture("Closed user settings");
    await enableEffort(fixture);
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-sonnet-5",
      { reasoningEffort: "high" },
    );
    const before = await settingsEvents(fixture);
    const settings = await readSettings(fixture);
    expect(settings).toStrictEqual({
      selectedModel: "claude-sonnet-5",
      modelSettings: { "claude-sonnet-5": { effort: "high" } },
      serviceTier: null,
    });
    const lastSeqId = await lastStreamSeqId(fixture);

    const closed = await closeSubject({
      subjectKind: "user",
      subjectId: fixture.userId,
    });

    await chat.requestUpdateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-4-8",
      [404],
      { reasoningEffort: "extra" },
    );

    await expect(readSettings(fixture)).resolves.toStrictEqual(settings);
    await expect(settingsEvents(fixture)).resolves.toStrictEqual(before);

    // The denied attempt left the durable sequence untouched, so the next
    // accepted update takes the very next two sidebar sequence ids.
    await removeErasureSubjectsFixture([closed.jobId]);
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-4-8",
      { reasoningEffort: "extra" },
    );
    const after = await settingsEvents(fixture);
    expect(after.slice(before.length)).toStrictEqual([
      { seqId: lastSeqId + 1, kind: "model_selection_updated" },
      { seqId: lastSeqId + 2, kind: "service_tier_updated" },
    ]);
    await expect(readSettings(fixture)).resolves.toStrictEqual({
      selectedModel: "claude-opus-4-8",
      modelSettings: {
        "claude-sonnet-5": { effort: "high" },
        "claude-opus-4-8": { effort: "extra" },
      },
      serviceTier: null,
    });
  });

  it("denies the update for a closed distinct Agent owner and for a closed organization", async () => {
    const shared = await createSettingsFixture("Shared owner settings");
    const sharedBefore = await readSettings(shared);
    const sharedOwner = `user_${randomUUID()}`;
    await transferAgentOwnerFixture({
      agentId: shared.agentId,
      owner: sharedOwner,
    });
    await closeSubject({ subjectKind: "user", subjectId: sharedOwner });

    await chat.requestUpdateThreadModelSelection(
      shared.actor,
      shared.threadId,
      "claude-opus-4-8",
      [404],
    );
    await expect(readSettings(shared)).resolves.toStrictEqual(sharedBefore);
    await expect(settingsEvents(shared)).resolves.toStrictEqual([]);

    const organization = await createSettingsFixture("Closed org settings");
    const organizationBefore = await readSettings(organization);
    await closeSubject({
      subjectKind: "organization",
      subjectId: organization.orgId,
    });

    await chat.requestUpdateThreadModelSelection(
      organization.actor,
      organization.threadId,
      "claude-opus-4-8",
      [404],
    );
    await expect(readSettings(organization)).resolves.toStrictEqual(
      organizationBefore,
    );
    await expect(settingsEvents(organization)).resolves.toStrictEqual([]);
  });

  it("keeps an unrelated owner updating while another subject is closed", async () => {
    const closed = await createSettingsFixture("Closed settings");
    const unrelated = await createSettingsFixture("Unrelated settings");
    await closeSubject({ subjectKind: "user", subjectId: closed.userId });

    await chat.requestUpdateThreadModelSelection(
      closed.actor,
      closed.threadId,
      "claude-opus-4-8",
      [404],
    );
    await expect(readSettings(closed)).resolves.toMatchObject({
      selectedModel: "claude-sonnet-5",
    });

    await chat.updateThreadModelSelection(
      unrelated.actor,
      unrelated.threadId,
      "claude-opus-4-8",
    );
    await expect(readSettings(unrelated)).resolves.toMatchObject({
      selectedModel: "claude-opus-4-8",
    });
  });

  it("makes a closure wait for an admitted update and fences the next one", async () => {
    const fixture = await createSettingsFixture("Admitted settings");
    const lastSeqId = await lastStreamSeqId(fixture);

    const closed = await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        work: async (barrier) => {
          const updating = chat.updateThreadModelSelection(
            fixture.actor,
            fixture.threadId,
            "claude-opus-4-8",
          );
          const settings = await barrier.entered;
          expect(settings.lockTimeout).toBe("1s");
          expect(settings.statementTimeout).toBe("5s");

          const closing = closeErasureSubjectFixture({
            subjectKind: "user",
            subjectId: fixture.userId,
          });
          // The admitted writer still holds its shared subject barrier with the
          // pin, the two durable sequences and both sidebar events already
          // written, so the exclusive closure cannot commit ahead of it.
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);

          barrier.release();
          await updating;
          return await closing;
        },
      },
      context.signal,
    );
    onTestFinished(async () => {
      await removeErasureSubjectsFixture([closed.jobId]);
    });

    const admitted = await settingsEvents(fixture);
    expect(admitted).toStrictEqual([
      { seqId: lastSeqId + 1, kind: "model_selection_updated" },
      { seqId: lastSeqId + 2, kind: "service_tier_updated" },
    ]);
    await expect(readSettings(fixture)).resolves.toMatchObject({
      selectedModel: "claude-opus-4-8",
    });

    // The closure landed behind the admitted write, so the next settings write
    // is rejected and changes nothing.
    await chat.requestUpdateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-sonnet-5",
      [404],
    );
    await expect(readSettings(fixture)).resolves.toMatchObject({
      selectedModel: "claude-opus-4-8",
    });
    await expect(settingsEvents(fixture)).resolves.toStrictEqual(admitted);
  });

  it("re-resolves a transferred Agent owner under the locks instead of repinning under a stale label", async () => {
    const fixture = await createSettingsFixture("Transferred owner settings");
    const before = await readSettings(fixture);
    const newOwner = `user_${randomUUID()}`;
    await closeSubject({ subjectKind: "user", subjectId: newOwner });

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "agent-lock",
        work: async (barrier) => {
          const updating = chat.requestUpdateThreadModelSelection(
            fixture.actor,
            fixture.threadId,
            "claude-opus-4-8",
            [404],
          );
          await barrier.entered;
          await transferAgentOwnerFixture({
            agentId: fixture.agentId,
            owner: newOwner,
          });
          barrier.release();
          await updating;
        },
      },
      context.signal,
    );

    await expect(readSettings(fixture)).resolves.toStrictEqual(before);
    await expect(settingsEvents(fixture)).resolves.toStrictEqual([]);
  });

  it("rolls the pin, effort, the first sidebar event and both sequences back when the second event fails", async () => {
    const fixture = await createSettingsFixture("Rolled back settings");
    await enableEffort(fixture);
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-sonnet-5",
      { reasoningEffort: "high" },
    );
    const before = await settingsEvents(fixture);
    const settings = await readSettings(fixture);
    const lastSeqId = await lastStreamSeqId(fixture);

    const modelEventId = randomUUID();
    const serviceTierEventId = randomUUID();
    const holder = await holdChatThreadEventIdFixture({
      eventId: serviceTierEventId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      chatThreadId: fixture.threadId,
      signal: context.signal,
    });
    // Holding the **second** event id is what makes this decisive: the update
    // has already written the pin columns and the merged `model_settings`,
    // appended the `model_selection_updated` event and reserved **both**
    // durable sequences before its last statement blocks on the held id and
    // fails on its own bounded budget. A genuine transaction failure is
    // neither a 204 nor the closure 404.
    await expect(
      chat.requestUpdateThreadModelSelection(
        fixture.actor,
        fixture.threadId,
        "claude-opus-4-8",
        [204, 404],
        {
          reasoningEffort: "extra",
          eventId: modelEventId,
          serviceTierEventId,
        },
      ),
    ).rejects.toThrow(/Unknown response status 500/);
    holder.release();
    await holder.done;

    await expect(readSettings(fixture)).resolves.toStrictEqual(settings);
    await expect(settingsEvents(fixture)).resolves.toStrictEqual(before);
    // The first event rolled back with the second: its client id is absent.
    await expect(eventIds(fixture)).resolves.not.toContain(modelEventId);

    // Neither reserved sequence was consumed, so the next accepted update
    // still takes the very next two sidebar sequence ids.
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-4-8",
      { reasoningEffort: "extra" },
    );
    const after = await settingsEvents(fixture);
    expect(after.slice(before.length)).toStrictEqual([
      { seqId: lastSeqId + 1, kind: "model_selection_updated" },
      { seqId: lastSeqId + 2, kind: "service_tier_updated" },
    ]);
  });

  it("propagates a held parent lock as a failure rather than a closure 404", async () => {
    const fixture = await createSettingsFixture("Blocked settings");
    const before = await readSettings(fixture);

    const holder = await holdChatThreadRowLockFixture({
      threadId: fixture.threadId,
      signal: context.signal,
    });
    // Neither an accepted 204 nor the closure 404: a real blocked parent lock
    // keeps its own database failure instead of being reported as erasure.
    await expect(
      chat.requestUpdateThreadModelSelection(
        fixture.actor,
        fixture.threadId,
        "claude-opus-4-8",
        [204, 404],
      ),
    ).rejects.toThrow(/Unknown response status 500/);
    holder.release();
    await holder.done;

    await expect(readSettings(fixture)).resolves.toStrictEqual(before);
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-4-8",
    );
    await expect(readSettings(fixture)).resolves.toMatchObject({
      selectedModel: "claude-opus-4-8",
    });
  });

  it("keeps the existing 404 for a wrong user, a missing thread and a null Agent", async () => {
    const fixture = await createSettingsFixture("Denied settings");
    const stranger = await createSettingsFixture("Stranger settings");
    const before = await readSettings(fixture);

    await chat.requestUpdateThreadModelSelection(
      stranger.actor,
      fixture.threadId,
      "claude-opus-4-8",
      [404],
    );
    await chat.requestUpdateThreadModelSelection(
      fixture.actor,
      randomUUID(),
      "claude-opus-4-8",
      [404],
    );

    await setChatThreadAgentFixture({
      chatThreadId: fixture.threadId,
      agentId: null,
    });
    await chat.requestUpdateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-4-8",
      [404],
    );
    await setChatThreadAgentFixture({
      chatThreadId: fixture.threadId,
      agentId: fixture.agentId,
    });

    await expect(readSettings(fixture)).resolves.toStrictEqual(before);
    await expect(settingsEvents(fixture)).resolves.toStrictEqual([]);
  });

  it("resolves ownership before model validation so a foreign thread leaks no catalog answer", async () => {
    const fixture = await createSettingsFixture("Ordered denial");
    const stranger = await createSettingsFixture("Ordered stranger");

    // The owner still gets the unchanged availability 400 for a supported model
    // this workspace has no policy for.
    const owned = await chat.requestUpdateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-sonnet-4-6",
      [400],
    );
    expect(owned.body).toMatchObject({
      error: {
        message: "The selected model is not available in this workspace",
      },
    });

    // The same body against a thread the caller does not own is now resolved as
    // not-found before the model is validated, so it no longer distinguishes an
    // unavailable model from a thread that was never theirs, and it never
    // reaches the policy bootstrap.
    await chat.requestUpdateThreadModelSelection(
      stranger.actor,
      fixture.threadId,
      "claude-sonnet-4-6",
      [404],
    );
    await expect(settingsEvents(fixture)).resolves.toStrictEqual([]);
  });
});

describe("account erasure fences the model-policy bootstrap this route performs", () => {
  it("initializes no policy for a closed subject and still initializes for an admitted one", async () => {
    const fixture = await createSettingsFixture("Unseeded policy");
    await stageUnrepairedOrgModelPolicyFixture({
      orgId: fixture.orgId,
      state: "unseeded",
    });
    await expect(policyModels(fixture)).resolves.toStrictEqual([]);

    const closed = await closeSubject({
      subjectKind: "user",
      subjectId: fixture.userId,
    });
    await chat.requestUpdateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-4-8",
      [404],
    );
    // The resolver runs inside the admitted transaction, so a denied request
    // creates no policy row and attributes nothing to the closed requester.
    await expect(policyModels(fixture)).resolves.toStrictEqual([]);

    await removeErasureSubjectsFixture([closed.jobId]);
    // Once admitted, the same request initializes the organization's policies
    // through the resolver's savepoint. The resolver can still reject the
    // selection afterwards, and that active-request behavior is deliberately
    // preserved: the seeded rows, not the response, are what prove admission
    // ran first. A rejected request still appends no event.
    const admitted = await chat.requestUpdateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-4-8",
      [400],
    );
    expect(admitted.body).toMatchObject({
      error: {
        message: "The selected model is not available in this workspace",
      },
    });
    await expect(policyModels(fixture)).resolves.not.toStrictEqual([]);
    await expect(policyDefaults(fixture)).resolves.toHaveLength(1);
    await expect(settingsEvents(fixture)).resolves.toStrictEqual([]);
  });

  it("repairs a missing default only for an admitted request", async () => {
    const fixture = await createSettingsFixture("Unrepaired policy");
    await stageUnrepairedOrgModelPolicyFixture({
      orgId: fixture.orgId,
      state: "missing_default",
    });
    const models = await policyModels(fixture);
    await expect(policyDefaults(fixture)).resolves.toStrictEqual([]);

    const closed = await closeSubject({
      subjectKind: "user",
      subjectId: fixture.userId,
    });
    await chat.requestUpdateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-4-8",
      [404],
    );
    await expect(policyDefaults(fixture)).resolves.toStrictEqual([]);
    await expect(policyModels(fixture)).resolves.toStrictEqual(models);

    await removeErasureSubjectsFixture([closed.jobId]);
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-4-8",
    );
    await expect(policyDefaults(fixture)).resolves.toHaveLength(1);
    await expect(readSettings(fixture)).resolves.toMatchObject({
      selectedModel: "claude-opus-4-8",
    });
  });

  it("rolls the default repair back with the thread mutation when the write fails", async () => {
    const fixture = await createSettingsFixture("Rolled back policy");
    await stageUnrepairedOrgModelPolicyFixture({
      orgId: fixture.orgId,
      state: "missing_default",
    });
    await expect(policyDefaults(fixture)).resolves.toStrictEqual([]);
    const settings = await readSettings(fixture);

    const serviceTierEventId = randomUUID();
    const holder = await holdChatThreadEventIdFixture({
      eventId: serviceTierEventId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      chatThreadId: fixture.threadId,
      signal: context.signal,
    });
    await expect(
      chat.requestUpdateThreadModelSelection(
        fixture.actor,
        fixture.threadId,
        "claude-opus-4-8",
        [204, 404],
        { serviceTierEventId },
      ),
    ).rejects.toThrow(/Unknown response status 500/);
    holder.release();
    await holder.done;

    // The repair used a savepoint on the admitted transaction, not a second
    // connection: it rolled back with the thread mutation it preceded.
    await expect(policyDefaults(fixture)).resolves.toStrictEqual([]);
    await expect(readSettings(fixture)).resolves.toStrictEqual(settings);
    await expect(settingsEvents(fixture)).resolves.toStrictEqual([]);

    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-4-8",
    );
    await expect(policyDefaults(fixture)).resolves.toHaveLength(1);
  });
});

describe("the fenced model-selection route keeps its own write semantics", () => {
  it("serializes concurrent same-thread efforts for different models without losing either", async () => {
    const fixture = await createSettingsFixture("Concurrent efforts");
    await enableEffort(fixture);
    const lastSeqId = await lastStreamSeqId(fixture);

    // Both writers hold the helper's retained `FOR KEY SHARE` on this thread.
    // `FOR NO KEY UPDATE` is compatible with that, so they serialize on the
    // settings row instead of deadlocking on a `FOR UPDATE` upgrade, and the
    // second read/modify/write sees the first one's committed sparse map.
    await Promise.all([
      chat.updateThreadModelSelection(
        fixture.actor,
        fixture.threadId,
        "claude-sonnet-5",
        { reasoningEffort: "high" },
      ),
      chat.updateThreadModelSelection(
        fixture.actor,
        fixture.threadId,
        "claude-opus-4-8",
        { reasoningEffort: "extra" },
      ),
    ]);

    await expect(readSettings(fixture)).resolves.toMatchObject({
      modelSettings: {
        "claude-sonnet-5": { effort: "high" },
        "claude-opus-4-8": { effort: "extra" },
      },
    });
    const events = await settingsEvents(fixture);
    expect(
      events.map((event) => {
        return event.seqId;
      }),
    ).toStrictEqual([
      lastSeqId + 1,
      lastSeqId + 2,
      lastSeqId + 3,
      lastSeqId + 4,
    ]);
  });

  it("overlaps a settings write with a rename under the shared helper", async () => {
    const fixture = await createSettingsFixture("Concurrent rename");

    await Promise.all([
      chat.updateThreadModelSelection(
        fixture.actor,
        fixture.threadId,
        "claude-opus-4-8",
      ),
      chat.renameThread(fixture.actor, fixture.threadId, "Concurrent title"),
    ]);

    await expect(
      chat.readThreadMetadata(fixture.actor, fixture.threadId),
    ).resolves.toMatchObject({
      selectedModel: "claude-opus-4-8",
      title: "Concurrent title",
    });
  });

  it("clears the pin on a null model and keeps both client event ids", async () => {
    const fixture = await createSettingsFixture("Cleared pin");
    const modelEventId = randomUUID();
    const serviceTierEventId = randomUUID();

    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      null,
      { eventId: modelEventId, serviceTierEventId },
    );

    await expect(readSettings(fixture)).resolves.toStrictEqual({
      selectedModel: null,
      modelSettings: {},
      serviceTier: null,
    });
    const ids = await eventIds(fixture);
    expect(ids).toContain(modelEventId);
    expect(ids).toContain(serviceTierEventId);
    const page = await readEventPage(fixture);
    expect(page).toContainEqual(
      expect.objectContaining({
        id: modelEventId,
        kind: "model_selection_updated",
        selectedModel: null,
      }),
    );
    expect(page).toContainEqual(
      expect.objectContaining({
        id: serviceTierEventId,
        kind: "service_tier_updated",
        serviceTier: null,
      }),
    );
  });
});
