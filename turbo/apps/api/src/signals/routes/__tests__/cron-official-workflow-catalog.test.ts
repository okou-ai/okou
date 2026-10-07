import { randomUUID } from "node:crypto";

import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { cronOfficialWorkflowCatalogContract } from "@okouai/api-contracts/contracts/cron";
import {
  OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
  type OfficialWorkflowBlueprint,
  type OfficialWorkflowSourceCatalog,
  type OfficialWorkflowSourceDefinition,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  testOfficialWorkflowCatalogStateContract,
  type TestOfficialWorkflowCatalogStateActionBody,
} from "@okouai/api-contracts/contracts/test-official-workflow-catalog-state";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { alterRegisteredVolumeIndexFixture } from "../../../test-fixtures/registered-volume-index";
import { createDeferredPromise } from "../../utils";
import {
  createCronOfficialWorkflowCatalogRoutes,
  cronOfficialWorkflowCatalogRoutes,
} from "../cron-official-workflow-catalog";
import { testOfficialWorkflowCatalogStateRoutes } from "../test-official-workflow-catalog-state";

const context = testContext();
const CRON_SECRET = "official-workflow-catalog-cron-secret";
const TEST_SUFFIX = randomUUID().replaceAll("-", "").slice(0, 12);

type ActiveDefinition = Extract<
  OfficialWorkflowSourceDefinition,
  { readonly lifecycle: "active" }
>;

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

function catalog(
  definitions: OfficialWorkflowSourceCatalog["definitions"],
): OfficialWorkflowSourceCatalog {
  return {
    schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
    definitions,
  };
}

function scheduleBlueprint(
  key: string,
  cronExpression = "0 8 * * *",
): OfficialWorkflowBlueprint {
  return {
    key,
    parameters: [
      {
        key: "include-weekends",
        type: "boolean",
        required: false,
        default: false,
      },
    ],
    desiredState: {
      kind: "schedule",
      schedule: {
        type: "cron",
        cronExpression,
      },
    },
    runtime: { resultEmail: false },
  };
}

function loopBlueprint(key: string): OfficialWorkflowBlueprint {
  return {
    key,
    parameters: [],
    desiredState: {
      kind: "schedule",
      schedule: { type: "loop", intervalSeconds: 3600 },
    },
    runtime: { resultEmail: false },
  };
}

function calendarBlueprint(
  key: string,
  calendarId: string | undefined,
): OfficialWorkflowBlueprint {
  return {
    key,
    parameters: [],
    desiredState: {
      kind: "event",
      eventType: "google-calendar-event-created",
      ...(calendarId === undefined
        ? {}
        : {
            eventConfig: {
              provider: "google-calendar",
              event: "event_created",
              calendarId,
            },
          }),
    },
    runtime: { resultEmail: false },
  };
}

function chatRunFinishedBlueprint(
  key: string,
  runStatuses: readonly ("completed" | "failed" | "cancelled")[],
): OfficialWorkflowBlueprint {
  return {
    key,
    parameters: [],
    desiredState: {
      kind: "event",
      eventType: "chat-run-finished",
      eventConfig: {
        provider: "chat",
        event: "run_finished",
        chatThreadId: "00000000-0000-4000-8000-000000000001",
        runStatuses: [...runStatuses],
      },
    },
    runtime: { resultEmail: false },
  };
}

function activeDefinition(
  name: string,
  options: {
    readonly instruction?: string;
    readonly blueprints?: readonly OfficialWorkflowBlueprint[];
    readonly category?: string;
    readonly files?: ActiveDefinition["workflow"]["files"];
  } = {},
): ActiveDefinition {
  return {
    name,
    lifecycle: "active",
    workflow: {
      displayName: `Display ${name}`,
      description: `Description for ${name}`,
      instruction: options.instruction ?? "Do the official work.",
      files: options.files ?? [
        { path: "references/b.md", content: "bravo\n" },
        { path: "references/a.md", content: "alpha\n" },
      ],
    },
    blueprints: [...(options.blueprints ?? [scheduleBlueprint("daily")])],
    presentation: {
      category: options.category ?? "productivity",
      order: 10,
      marketingCopy: "A catalog-only description.",
    },
  };
}

function retiredDefinition(
  name: string,
): Extract<
  OfficialWorkflowSourceDefinition,
  { readonly lifecycle: "retired" }
> {
  return {
    name,
    lifecycle: "retired",
    presentation: {
      category: "retired",
      order: 99,
      marketingCopy: "This Definition has retired.",
    },
  };
}

function syncClient(candidate: unknown) {
  return setupApp({
    context,
    routes: createCronOfficialWorkflowCatalogRoutes(candidate),
  })(cronOfficialWorkflowCatalogContract);
}

async function syncCatalog(candidate: unknown) {
  return await (async () => {
    return await accept(
      syncClient(candidate).sync({ headers: cronHeaders() }),
      [200],
    );
  })();
}

async function syncDeployedCatalog() {
  return await (async () => {
    return await accept(
      setupApp({ context, routes: cronOfficialWorkflowCatalogRoutes })(
        cronOfficialWorkflowCatalogContract,
      ).sync({ headers: cronHeaders() }),
      [200],
    );
  })();
}

async function syncCatalogUnauthorized(candidate: unknown) {
  return await accept(
    syncClient(candidate).sync({ headers: cronHeaders("wrong-secret") }),
    [401],
  );
}

function stateClient() {
  return setupApp({
    context,
    routes: testOfficialWorkflowCatalogStateRoutes,
  })(testOfficialWorkflowCatalogStateContract);
}

async function stateAction(body: TestOfficialWorkflowCatalogStateActionBody) {
  return await accept(stateClient().action({ body }), [200]);
}

async function readState(definitionName?: string, revision?: string) {
  return await stateAction({
    action: "read",
    ...(definitionName === undefined ? {} : { definitionName }),
    ...(revision === undefined ? {} : { revision }),
  });
}

function s3BodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  throw new Error("Expected an S3 object body");
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

function missingS3Object(key: string): Error {
  return Object.assign(new Error(`Missing S3 object ${key}`), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function installVolumeS3Fixture() {
  const objects = new Map<string, Buffer>();
  const writes: string[] = [];
  let putAttempt = 0;
  let failingPutAttempt: number | null = null;
  let blockedPut:
    | {
        readonly attempt: number;
        readonly started: ReturnType<typeof createDeferredPromise<void>>;
        readonly released: ReturnType<typeof createDeferredPromise<void>>;
      }
    | undefined;

  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key;
      if (!key) {
        throw new Error("Expected an S3 object key");
      }
      putAttempt += 1;
      if (putAttempt === failingPutAttempt) {
        failingPutAttempt = null;
        return Promise.reject(new Error("Injected external storage failure"));
      }
      const storeObject = () => {
        objects.set(key, s3BodyBuffer(command.input.Body));
        writes.push(key);
        return {};
      };
      if (blockedPut?.attempt === putAttempt) {
        const blocked = blockedPut;
        blockedPut = undefined;
        blocked.started.resolve(undefined);
        return blocked.released.promise.then(storeObject);
      }
      return Promise.resolve(storeObject());
    }
    if (command instanceof HeadObjectCommand) {
      const key = command.input.Key;
      if (!key) {
        throw new Error("Expected an S3 object key");
      }
      const body = objects.get(key);
      if (!body) {
        return Promise.reject(missingS3Object(key));
      }
      return Promise.resolve({ ContentLength: body.length });
    }
    return Promise.resolve({});
  });

  return {
    objects,
    writes,
    clearWrites(): void {
      writes.length = 0;
    },
    failPutAttempt(attempt: number): void {
      failingPutAttempt = putAttempt + attempt;
    },
    blockNextPut(): {
      readonly started: Promise<void>;
      readonly release: () => void;
    } {
      if (blockedPut) {
        throw new Error("An S3 put is already blocked");
      }
      const started = createDeferredPromise<void>(context.signal);
      const released = createDeferredPromise<void>(context.signal);
      blockedPut = { attempt: putAttempt + 1, started, released };
      return {
        started: started.promise,
        release: () => {
          released.resolve(undefined);
        },
      };
    },
  };
}

beforeEach(async () => {
  await setupApp({ context, routes: [], isolatePg: true });
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockEnv(
    "R2_USER_STORAGES_BUCKET_NAME",
    `official-workflow-catalog-test-${randomUUID()}`,
  );
  // The accepted catalog is one infrastructure-owned singleton with no reset
  // endpoint. This test-only external route is the narrow exception needed to
  // construct independent initial-release scenarios without importing DB state.
  await stateAction({ action: "cleanup" });
});

describe("Official Workflow catalog release boundary", () => {
  it("replaces a previous schema release with retained historical revisions", async () => {
    const seeded = await stateAction({
      action: "seed-previous-schema-release",
    });
    expect(seeded.body).toMatchObject({
      catalog: null,
      counts: {
        releases: 1,
        revisions: 1,
        storages: 1,
        storageVersions: 1,
      },
    });

    const synced = await syncCatalog(catalog([]));
    expect(synced.body).toMatchObject({
      outcome: "accepted",
      diagnostics: [],
    });

    const state = await readState();
    expect(state.body.catalog).toMatchObject({
      releaseId: synced.body.releaseId,
      payload: {
        schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
        definitions: [],
      },
    });
    expect(state.body.counts).toMatchObject({
      releases: 2,
      revisions: 1,
      storages: 1,
      storageVersions: 1,
    });
  });

  it("authenticates sync and accepts an idempotent empty initial catalog", async () => {
    const unauthorized = await syncCatalogUnauthorized(catalog([]));
    expect(unauthorized.status).toBe(401);

    const first = await syncCatalog(catalog([]));
    expect(first).toMatchObject({
      status: 200,
      body: { outcome: "accepted", diagnostics: [] },
    });
    const second = await syncCatalog(catalog([]));
    expect(second).toMatchObject({
      status: 200,
      body: {
        outcome: "unchanged",
        releaseId: first.body.releaseId,
        diagnostics: [],
      },
    });

    const state = await readState();
    expect(state.body.catalog).toMatchObject({
      releaseId: first.body.releaseId,
      payload: { definitions: [] },
    });
    expect(state.body.counts).toStrictEqual({
      releases: 1,
      revisions: 0,
      storages: 0,
      storageVersions: 0,
    });
  });

  it("retires Connector Doctor while retaining its released identity and Morning Brief behavior", async () => {
    const s3 = installVolumeS3Fixture();
    const historicalBlueprint: OfficialWorkflowBlueprint = {
      key: "weekly-check",
      parameters: [],
      desiredState: {
        kind: "schedule",
        schedule: {
          type: "cron",
          cronExpression: "0 9 * * 1",
        },
      },
      runtime: { resultEmail: false },
    };
    const released = await syncCatalog(
      catalog([
        activeDefinition("connector-doctor", {
          blueprints: [historicalBlueprint],
        }),
      ]),
    );
    expect(released.body).toMatchObject({
      outcome: "accepted",
      diagnostics: [],
    });
    const releasedConnectorDoctor = requireValue(
      (await readState("connector-doctor")).body.definition,
      "Expected the released Connector Doctor Definition",
    );
    expect(releasedConnectorDoctor).toMatchObject({
      name: "connector-doctor",
      lifecycle: "active",
      blueprints: [{ key: "weekly-check" }],
      releasedBlueprintKeys: ["weekly-check"],
    });

    const first = await syncDeployedCatalog();
    expect(first.body).toMatchObject({
      outcome: "accepted",
      diagnostics: [],
    });

    const morningBriefState = await readState("morning-brief");
    const connectorDoctorState = await readState("connector-doctor");
    const deployedCatalog = requireValue(
      morningBriefState.body.catalog,
      "Expected the deployed catalog release",
    );
    const morningBriefDefinition = requireValue(
      morningBriefState.body.definition,
      "Expected the Morning Brief Definition",
    );
    const connectorDoctorDefinition = requireValue(
      connectorDoctorState.body.definition,
      "Expected the retired Connector Doctor Definition",
    );
    expect(
      deployedCatalog.payload.definitions.map(({ name, lifecycle }) => {
        return { name, lifecycle };
      }),
    ).toStrictEqual([
      { name: "connector-doctor", lifecycle: "retired" },
      { name: "morning-brief", lifecycle: "active" },
    ]);
    expect(morningBriefDefinition).toMatchObject({
      name: "morning-brief",
      lifecycle: "active",
      blueprints: [
        {
          key: "daily-delivery",
          parameters: [],
          desiredState: {
            kind: "schedule",
            schedule: {
              type: "cron",
              cronExpression: "0 7 * * *",
            },
          },
          runtime: { resultEmail: true },
        },
      ],
    });
    expect(connectorDoctorDefinition).toMatchObject({
      name: "connector-doctor",
      lifecycle: "retired",
      blueprints: [{ key: "weekly-check" }],
      releasedBlueprintKeys: ["weekly-check"],
      presentation: { category: "productivity" },
    });
    expect(connectorDoctorDefinition.revision).toBe(
      releasedConnectorDoctor.revision,
    );
    expect(connectorDoctorDefinition.artifact).toStrictEqual(
      releasedConnectorDoctor.artifact,
    );
    expect(connectorDoctorDefinition.blueprints).toStrictEqual(
      releasedConnectorDoctor.blueprints,
    );
    expect(connectorDoctorDefinition.releasedBlueprintKeys).toStrictEqual(
      releasedConnectorDoctor.releasedBlueprintKeys,
    );
    expect(morningBriefState.body.storage).toMatchObject({
      storageName: "official-workflow@morning-brief",
      orgId: SYSTEM_ORG_ID,
      userId: VOLUME_ORG_USER_ID,
      headVersionId: morningBriefDefinition.artifact.storageVersion,
      versionCount: 1,
    });
    expect(connectorDoctorState.body.storage).toMatchObject({
      storageName: "official-workflow@connector-doctor",
      orgId: SYSTEM_ORG_ID,
      userId: VOLUME_ORG_USER_ID,
      headVersionId: releasedConnectorDoctor.artifact.storageVersion,
      versionCount: 1,
    });
    expect(morningBriefState.body.counts).toStrictEqual({
      releases: 2,
      revisions: 2,
      storages: 2,
      storageVersions: 2,
    });
    expect(s3.objects.size).toBe(4);

    const morningBriefRevision = morningBriefDefinition.revision;
    const exactMorningBrief = await readState(
      "morning-brief",
      morningBriefRevision,
    );
    const exactMorningBriefRevision = requireValue(
      exactMorningBrief.body.revision,
      "Expected the exact Morning Brief revision",
    );
    const morningBriefInstruction =
      exactMorningBriefRevision.definition.workflow.instruction;
    expect(exactMorningBriefRevision.definition.workflow).toMatchObject({
      displayName: "Morning Brief",
      description:
        "Summarize today's email, GitHub, calendar, connected Slack activity from the past 24 hours, and unread Chat priorities.",
      files: [],
    });
    expect(morningBriefInstruction).toContain("Gmail connector skill");
    expect(morningBriefInstruction).toContain("GitHub connector skill");
    expect(morningBriefInstruction).toContain(
      "Google Calendar connector skill",
    );
    expect(morningBriefInstruction).toContain(
      "okou chat list --unread --all-agents",
    );
    expect(morningBriefInstruction).toContain(
      "Never invent, infer, or claim source data",
    );
    expect(morningBriefInstruction).toContain("Do not send email");
    expect(morningBriefInstruction).not.toMatch(
      /morning-brief-(?:collect|run)|morning_brief|chat_morning_brief_context/,
    );

    const exactConnectorDoctor = await readState(
      "connector-doctor",
      releasedConnectorDoctor.revision,
    );
    const exactConnectorDoctorRevision = requireValue(
      exactConnectorDoctor.body.revision,
      "Expected the exact historical Connector Doctor revision",
    );
    expect(exactConnectorDoctorRevision.definition.revision).toBe(
      releasedConnectorDoctor.revision,
    );
    expect(exactConnectorDoctorRevision.definition.blueprints).toStrictEqual(
      releasedConnectorDoctor.blueprints,
    );
    expect(exactConnectorDoctorRevision.artifact).toStrictEqual(
      releasedConnectorDoctor.artifact,
    );

    expect(morningBriefRevision).not.toBe(releasedConnectorDoctor.revision);
    expect(morningBriefDefinition.blueprints[0]?.fingerprint).not.toBe(
      connectorDoctorDefinition.blueprints[0]?.fingerprint,
    );
    expect(morningBriefDefinition.artifact.storageVersion).not.toBe(
      connectorDoctorDefinition.artifact.storageVersion,
    );
    const firstIdentities = {
      morningBrief: {
        revision: morningBriefDefinition.revision,
        blueprintFingerprint: morningBriefDefinition.blueprints[0]?.fingerprint,
        artifact: morningBriefDefinition.artifact,
      },
      connectorDoctor: {
        revision: connectorDoctorDefinition.revision,
        blueprintFingerprint:
          connectorDoctorDefinition.blueprints[0]?.fingerprint,
        artifact: connectorDoctorDefinition.artifact,
      },
    };
    s3.clearWrites();
    const second = await syncDeployedCatalog();
    expect(second.body).toMatchObject({
      outcome: "unchanged",
      releaseId: first.body.releaseId,
      diagnostics: [],
    });
    const secondMorningBrief = requireValue(
      (await readState("morning-brief")).body.definition,
      "Expected the unchanged Morning Brief Definition",
    );
    const secondConnectorDoctor = requireValue(
      (await readState("connector-doctor")).body.definition,
      "Expected the unchanged retired Connector Doctor Definition",
    );
    expect({
      morningBrief: {
        revision: secondMorningBrief.revision,
        blueprintFingerprint: secondMorningBrief.blueprints[0]?.fingerprint,
        artifact: secondMorningBrief.artifact,
      },
      connectorDoctor: {
        revision: secondConnectorDoctor.revision,
        blueprintFingerprint: secondConnectorDoctor.blueprints[0]?.fingerprint,
        artifact: secondConnectorDoctor.artifact,
      },
    }).toStrictEqual(firstIdentities);
    expect(s3.writes).toStrictEqual([]);
  });

  it("accepts multiple Definitions as one release with exact system artifacts", async () => {
    const s3 = installVolumeS3Fixture();
    const alpha = `api-test-alpha-${TEST_SUFFIX}`;
    const beta = `api-test-beta-${TEST_SUFFIX}`;
    const response = await syncCatalog(
      catalog([
        activeDefinition(alpha, { blueprints: [] }),
        activeDefinition(beta, { blueprints: [loopBlueprint("hourly")] }),
      ]),
    );
    expect(response.body).toMatchObject({
      outcome: "accepted",
      diagnostics: [],
    });

    const alphaState = await readState(alpha);
    const betaDefinition = (await readState(beta)).body.definition;
    expect(alphaState.body.catalog?.payload.definitions).toHaveLength(2);
    expect(alphaState.body.definition?.blueprints).toStrictEqual([]);
    expect(betaDefinition?.blueprints).toHaveLength(1);
    expect(alphaState.body.storage).toMatchObject({
      storageName: `official-workflow@${alpha}`,
      orgId: SYSTEM_ORG_ID,
      userId: VOLUME_ORG_USER_ID,
      headVersionId: alphaState.body.definition?.artifact.storageVersion,
      versionCount: 1,
    });

    const revision = alphaState.body.definition?.revision;
    expect(revision).toBeDefined();
    const exact = await readState(alpha, revision);
    expect(exact.body.revision).toMatchObject({
      definition: { name: alpha, revision },
      artifact: alphaState.body.definition?.artifact,
    });
    expect(alphaState.body.counts).toStrictEqual({
      releases: 1,
      revisions: 2,
      storages: 2,
      storageVersions: 2,
    });
    expect(s3.objects.size).toBe(4);
  });

  it("computes canonical Definition revisions and independent Blueprint fingerprints", async () => {
    const s3 = installVolumeS3Fixture();
    const name = `api-test-fingerprints-${TEST_SUFFIX}`;
    const daily = scheduleBlueprint("daily");
    const hourly = loopBlueprint("hourly");
    const initial = activeDefinition(name, { blueprints: [daily, hourly] });
    await syncCatalog(catalog([initial]));
    const first = (await readState(name)).body.definition;
    expect(first).not.toBeNull();
    const firstFingerprints = new Map(
      first?.blueprints.map((blueprint) => {
        return [blueprint.key, blueprint.fingerprint] as const;
      }),
    );

    const reorderedDaily: OfficialWorkflowBlueprint = {
      ...daily,
      parameters: [...daily.parameters].reverse(),
    };
    const reordered: ActiveDefinition = {
      ...initial,
      workflow: {
        ...initial.workflow,
        files: [...initial.workflow.files].reverse(),
      },
      blueprints: [hourly, reorderedDaily],
    };
    const reorderSync = await syncCatalog(catalog([reordered]));
    expect(reorderSync.body).toMatchObject({
      outcome: "unchanged",
      releaseId: (await readState()).body.catalog?.releaseId,
    });

    const instructionSync = await syncCatalog(
      catalog([
        activeDefinition(name, {
          instruction: "Use the revised instruction.",
          blueprints: [daily, hourly],
        }),
      ]),
    );
    expect(instructionSync.body.outcome).toBe("accepted");
    const instructionChanged = (await readState(name)).body.definition;
    expect(instructionChanged?.revision).not.toBe(first?.revision);
    expect(
      instructionChanged?.blueprints.map((blueprint) => {
        return [blueprint.key, blueprint.fingerprint];
      }),
    ).toStrictEqual(
      first?.blueprints.map((blueprint) => {
        return [blueprint.key, blueprint.fingerprint];
      }),
    );

    const revisedFiles = [
      { path: "references/b.md", content: "revised bravo\n" },
      { path: "references/a.md", content: "alpha\n" },
    ];
    const filesSync = await syncCatalog(
      catalog([
        activeDefinition(name, {
          instruction: "Use the revised instruction.",
          blueprints: [daily, hourly],
          files: revisedFiles,
        }),
      ]),
    );
    expect(filesSync.body.outcome).toBe("accepted");
    const filesChanged = (await readState(name)).body.definition;
    expect(filesChanged?.revision).not.toBe(instructionChanged?.revision);
    expect(filesChanged?.blueprints).toStrictEqual(
      instructionChanged?.blueprints,
    );

    const blueprintSync = await syncCatalog(
      catalog([
        activeDefinition(name, {
          instruction: "Use the revised instruction.",
          blueprints: [scheduleBlueprint("daily", "30 8 * * *"), hourly],
          files: revisedFiles,
        }),
      ]),
    );
    expect(blueprintSync.body.outcome).toBe("accepted");
    const blueprintChanged = (await readState(name)).body.definition;
    expect(blueprintChanged?.revision).not.toBe(filesChanged?.revision);
    expect(
      blueprintChanged?.blueprints.find((blueprint) => {
        return blueprint.key === "daily";
      })?.fingerprint,
    ).not.toBe(firstFingerprints.get("daily"));
    expect(
      blueprintChanged?.blueprints.find((blueprint) => {
        return blueprint.key === "hourly";
      })?.fingerprint,
    ).toBe(firstFingerprints.get("hourly"));

    s3.clearWrites();
    const presentationSync = await syncCatalog(
      catalog([
        activeDefinition(name, {
          instruction: "Use the revised instruction.",
          blueprints: [scheduleBlueprint("daily", "30 8 * * *"), hourly],
          category: "operations",
          files: revisedFiles,
        }),
      ]),
    );
    expect(presentationSync.body.outcome).toBe("accepted");
    const presentationChanged = await readState(name);
    expect(presentationChanged.body.definition).toMatchObject({
      revision: blueprintChanged?.revision,
      blueprints: blueprintChanged?.blueprints,
      presentation: { category: "operations" },
    });
    expect(presentationChanged.body.counts).toStrictEqual({
      releases: 5,
      revisions: 4,
      storages: 1,
      storageVersions: 4,
    });
    expect(s3.writes).toStrictEqual([]);
  });

  it("rejects omitted and non-canonical Calendar event configuration", async () => {
    installVolumeS3Fixture();
    const name = `api-test-event-calendar-validation-${TEST_SUFFIX}`;
    const omittedCalendarDefault = await syncCatalog(
      catalog([
        activeDefinition(name, {
          blueprints: [calendarBlueprint("calendar", undefined)],
        }),
      ]),
    );
    expect(omittedCalendarDefault.body).toMatchObject({
      outcome: "rejected",
      releaseId: null,
      diagnostics: [{ code: "invalid-blueprint-configuration" }],
    });

    const trimmedCalendar = await syncCatalog(
      catalog([
        activeDefinition(name, {
          blueprints: [calendarBlueprint("calendar", " primary ")],
        }),
      ]),
    );
    expect(trimmedCalendar.body).toMatchObject({
      outcome: "rejected",
      releaseId: null,
      diagnostics: [{ code: "invalid-blueprint-configuration" }],
    });
  });

  it("canonicalizes duplicate and reordered chat-run statuses", async () => {
    installVolumeS3Fixture();
    const name = `api-test-event-statuses-${TEST_SUFFIX}`;
    const duplicateSet = chatRunFinishedBlueprint("chat", [
      "failed",
      "completed",
      "failed",
    ]);
    const accepted = await syncCatalog(
      catalog([
        activeDefinition(name, {
          blueprints: [calendarBlueprint("calendar", "primary"), duplicateSet],
        }),
      ]),
    );
    expect(accepted.body.outcome).toBe("accepted");
    const initial = (await readState(name)).body.definition;
    expect(
      initial?.blueprints.find((blueprint) => {
        return blueprint.key === "chat";
      })?.desiredState,
    ).toMatchObject({ eventConfig: { runStatuses: ["completed", "failed"] } });

    const reorderedSet = chatRunFinishedBlueprint("chat", [
      "completed",
      "failed",
    ]);
    const equivalent = await syncCatalog(
      catalog([
        activeDefinition(name, {
          blueprints: [reorderedSet, calendarBlueprint("calendar", "primary")],
        }),
      ]),
    );
    expect(equivalent.body).toMatchObject({
      outcome: "unchanged",
      releaseId: accepted.body.releaseId,
    });
  });

  it("changes only the revised event Blueprint fingerprint", async () => {
    installVolumeS3Fixture();
    const name = `api-test-event-fingerprint-${TEST_SUFFIX}`;
    const chat = chatRunFinishedBlueprint("chat", ["completed", "failed"]);
    const accepted = await syncCatalog(
      catalog([
        activeDefinition(name, {
          blueprints: [calendarBlueprint("calendar", "primary"), chat],
        }),
      ]),
    );
    expect(accepted.body.outcome).toBe("accepted");
    const initial = (await readState(name)).body.definition;

    const changed = await syncCatalog(
      catalog([
        activeDefinition(name, {
          blueprints: [calendarBlueprint("calendar", "secondary"), chat],
        }),
      ]),
    );
    expect(changed.body.outcome).toBe("accepted");
    const revised = (await readState(name)).body.definition;
    expect(revised?.revision).not.toBe(initial?.revision);
    expect(
      revised?.blueprints.find((blueprint) => {
        return blueprint.key === "calendar";
      })?.fingerprint,
    ).not.toBe(
      initial?.blueprints.find((blueprint) => {
        return blueprint.key === "calendar";
      })?.fingerprint,
    );
    expect(
      revised?.blueprints.find((blueprint) => {
        return blueprint.key === "chat";
      })?.fingerprint,
    ).toBe(
      initial?.blueprints.find((blueprint) => {
        return blueprint.key === "chat";
      })?.fingerprint,
    );
  });

  it("rejects the complete invalid candidate, duplicates, and non-canonical input", async () => {
    installVolumeS3Fixture();
    const name = `api-test-validation-${TEST_SUFFIX}`;
    const baselineCatalog = catalog([activeDefinition(name)]);
    const accepted = await syncCatalog(baselineCatalog);
    const acceptedReleaseId = accepted.body.releaseId;
    const acceptedRevision = (await readState(name)).body.definition?.revision;
    expect(acceptedRevision).toBeDefined();

    const unknownFieldName = `api-test-invalid-${TEST_SUFFIX}`;
    const invalidDefinition = {
      ...activeDefinition(unknownFieldName),
      unknownField: "must fail closed",
    };
    const invalid = await syncCatalog({
      schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
      definitions: [activeDefinition(name), invalidDefinition],
    });
    expect(invalid.body).toMatchObject({
      outcome: "rejected",
      releaseId: acceptedReleaseId,
      diagnostics: [{ code: "invalid-candidate" }],
    });

    const invalidName = await syncCatalog({
      schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
      definitions: [
        { ...activeDefinition(name), name: "Invalid Definition Name" },
      ],
    });
    expect(invalidName.body).toMatchObject({
      outcome: "rejected",
      releaseId: acceptedReleaseId,
      diagnostics: [{ code: "invalid-candidate" }],
    });
    expect(invalidName.body.diagnostics[0]).not.toHaveProperty(
      "definitionName",
    );

    const duplicateDefinition = await syncCatalog(
      catalog([activeDefinition(name), activeDefinition(name)]),
    );
    expect(duplicateDefinition.body.diagnostics).toContainEqual(
      expect.objectContaining({ code: "duplicate-definition-name" }),
    );

    const duplicateBlueprint = scheduleBlueprint("daily");
    const duplicateBlueprintResponse = await syncCatalog(
      catalog([
        activeDefinition(name, {
          blueprints: [duplicateBlueprint, duplicateBlueprint],
        }),
      ]),
    );
    expect(duplicateBlueprintResponse.body.diagnostics).toContainEqual(
      expect.objectContaining({ code: "duplicate-blueprint-key" }),
    );

    const invalidConfiguration = await syncCatalog(
      catalog([
        activeDefinition(name, {
          blueprints: [
            {
              ...loopBlueprint("invalid-loop"),
              desiredState: {
                kind: "schedule",
                schedule: { type: "loop", intervalSeconds: -1 },
              },
            },
          ],
        }),
      ]),
    );
    expect(invalidConfiguration.body.diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid-blueprint-configuration" }),
    );

    const invalidParameter = await syncCatalog({
      schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
      definitions: [
        {
          ...activeDefinition(name),
          blueprints: [
            {
              ...scheduleBlueprint("daily"),
              parameters: [
                {
                  key: "callback-url",
                  type: "string",
                  format: "url",
                  required: true,
                  default: "not-a-url",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(invalidParameter.body.diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid-parameter-declaration" }),
    );

    const unknownRuntimeSetting = await syncCatalog({
      schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
      definitions: [
        {
          ...activeDefinition(name),
          blueprints: [
            {
              ...scheduleBlueprint("daily"),
              runtime: { resultEmail: false, futureSetting: true },
            },
          ],
        },
      ],
    });
    expect(unknownRuntimeSetting.body.diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid-candidate" }),
    );

    for (const runtime of [{}, { resultEmail: "yes" }]) {
      const malformedRuntime = await syncCatalog({
        schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
        definitions: [
          {
            ...activeDefinition(name),
            blueprints: [
              {
                ...scheduleBlueprint("daily"),
                runtime,
              },
            ],
          },
        ],
      });
      expect(malformedRuntime.body.diagnostics).toContainEqual(
        expect.objectContaining({ code: "invalid-candidate" }),
      );
    }

    const nonCanonical = await syncCatalog(
      catalog([
        activeDefinition(name, { instruction: "Windows line\r\nbreak" }),
      ]),
    );
    expect(nonCanonical.body.diagnostics).toContainEqual(
      expect.objectContaining({ code: "non-canonical-value" }),
    );

    const blueprintWithUndefined = scheduleBlueprint("daily");
    const explicitUndefined = await syncCatalog({
      schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
      definitions: [
        {
          ...activeDefinition(name),
          blueprints: [
            {
              ...blueprintWithUndefined,
              desiredState: {
                ...blueprintWithUndefined.desiredState,
                autonomyBudget: undefined,
              },
            },
          ],
        },
      ],
    });
    expect(explicitUndefined.body).toMatchObject({
      outcome: "rejected",
      releaseId: acceptedReleaseId,
      diagnostics: [
        {
          code: "non-canonical-value",
          path: [
            "definitions",
            0,
            "blueprints",
            0,
            "desiredState",
            "autonomyBudget",
          ],
          definitionName: name,
          blueprintKey: "daily",
        },
      ],
    });

    const state = await readState(name);
    expect(state.body.catalog?.releaseId).toBe(acceptedReleaseId);
    expect(state.body.definition?.revision).toBe(acceptedRevision);
    expect(state.body.counts).toStrictEqual({
      releases: 1,
      revisions: 1,
      storages: 1,
      storageVersions: 1,
    });
  });

  it("does not expose a partial candidate when later artifact preparation fails", async () => {
    const s3 = installVolumeS3Fixture();
    const empty = await syncCatalog(catalog([]));
    const alpha = `api-test-partial-alpha-${TEST_SUFFIX}`;
    const beta = `api-test-partial-beta-${TEST_SUFFIX}`;
    s3.failPutAttempt(3);
    const failed = await syncCatalog(
      catalog([activeDefinition(alpha), activeDefinition(beta)]),
    );
    expect(failed.body).toMatchObject({
      outcome: "rejected",
      releaseId: empty.body.releaseId,
      diagnostics: [{ code: "artifact-preparation-failed" }],
    });

    const afterFailure = await readState();
    expect(afterFailure.body.catalog).toMatchObject({
      releaseId: empty.body.releaseId,
      payload: { definitions: [] },
    });
    expect(afterFailure.body.counts).toStrictEqual({
      releases: 1,
      revisions: 0,
      storages: 2,
      storageVersions: 0,
    });

    const retried = await syncCatalog(
      catalog([activeDefinition(alpha), activeDefinition(beta)]),
    );
    expect(retried.body.outcome).toBe("accepted");
    expect((await readState()).body.counts).toStrictEqual({
      releases: 2,
      revisions: 2,
      storages: 2,
      storageVersions: 2,
    });
  });

  it("reuses registered objects without changing the accepted identity", async () => {
    installVolumeS3Fixture();
    const name = `api-test-reuse-${TEST_SUFFIX}`;
    await syncCatalog(catalog([activeDefinition(name)]));
    const initial = (await readState(name)).body.definition;
    context.mocks.s3.send.mockClear();
    const repeated = await syncCatalog(catalog([activeDefinition(name)]));
    expect(repeated.body.outcome).toBe("unchanged");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    const retained = await readState(name);
    expect(retained.body.definition).toMatchObject({
      revision: initial?.revision,
      artifact: initial?.artifact,
    });
    expect(retained.body.counts).toStrictEqual({
      releases: 1,
      revisions: 1,
      storages: 1,
      storageVersions: 1,
    });
  });

  it("reuses the retained artifact through retirement and repeated sync", async () => {
    installVolumeS3Fixture();
    const name = `api-test-retired-reuse-${TEST_SUFFIX}`;
    await syncCatalog(catalog([activeDefinition(name)]));
    const active = (await readState(name)).body.definition;
    context.mocks.s3.send.mockClear();
    const retirement = await syncCatalog(catalog([retiredDefinition(name)]));
    expect(retirement.body.outcome).toBe("accepted");
    const repeated = await syncCatalog(catalog([retiredDefinition(name)]));
    expect(repeated.body.outcome).toBe("unchanged");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    const retained = await readState(name);
    expect(retained.body.definition).toMatchObject({
      lifecycle: "retired",
      revision: active?.revision,
      artifact: active?.artifact,
    });
    expect(retained.body.counts).toStrictEqual({
      releases: 2,
      revisions: 1,
      storages: 1,
      storageVersions: 1,
    });
  });

  it("retains historical revisions without probing or rewriting their objects", async () => {
    installVolumeS3Fixture();
    const name = `api-test-historical-reuse-${TEST_SUFFIX}`;
    await syncCatalog(catalog([activeDefinition(name)]));
    const first = (await readState(name)).body.definition;
    const currentCandidate = activeDefinition(name, {
      instruction: "Use the second durable revision.",
    });
    await syncCatalog(catalog([currentCandidate]));
    const second = (await readState(name)).body.definition;
    if (!first?.revision || !second?.revision) {
      throw new Error("Expected two exact registered revisions");
    }
    expect(second.revision).not.toBe(first.revision);
    context.mocks.s3.send.mockClear();
    const repeated = await syncCatalog(catalog([currentCandidate]));
    expect(repeated.body.outcome).toBe("unchanged");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    const retained = await readState(name);
    expect(retained.body.definition).toMatchObject({
      revision: second.revision,
      artifact: second.artifact,
    });
    expect((await readState(name, first.revision)).body.revision).toMatchObject(
      {
        definition: { revision: first.revision },
        artifact: first.artifact,
      },
    );
    expect(
      (await readState(name, second.revision)).body.revision,
    ).toMatchObject({
      definition: { revision: second.revision },
      artifact: second.artifact,
    });
    expect(retained.body.counts).toStrictEqual({
      releases: 2,
      revisions: 2,
      storages: 1,
      storageVersions: 2,
    });
  });

  it("reuses an exact ready artifact through A-B-A and repeated historical preparation", async () => {
    installVolumeS3Fixture();
    const name = `api-test-index-aba-${TEST_SUFFIX}`;
    const firstCandidate = activeDefinition(name);
    const firstRelease = await syncCatalog(catalog([firstCandidate]));
    const first = requireValue(
      (await readState(name)).body.definition,
      "Expected the first Definition",
    );
    await syncCatalog(
      catalog([activeDefinition(name, { instruction: "Publish revision B." })]),
    );
    const second = requireValue(
      (await readState(name)).body.definition,
      "Expected the second Definition",
    );
    expect(second.revision).not.toBe(first.revision);

    context.mocks.s3.send.mockClear();
    const reverted = await syncCatalog(catalog([firstCandidate]));
    expect(reverted.body).toMatchObject({
      outcome: "accepted",
      releaseId: firstRelease.body.releaseId,
    });
    expect((await readState(name)).body.definition).toMatchObject({
      revision: first.revision,
      artifact: first.artifact,
    });
    expect((await syncCatalog(catalog([firstCandidate]))).body.outcome).toBe(
      "unchanged",
    );
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    const retained = await readState(name, second.revision);
    expect(retained.body.revision).toMatchObject({
      definition: { revision: second.revision },
      artifact: second.artifact,
    });
    // Releases are content-addressed too: A-B-A reuses the first release ID.
    expect(retained.body.counts).toStrictEqual({
      releases: 2,
      revisions: 2,
      storages: 1,
      storageVersions: 2,
    });
  });

  it("rejects a corrupted historical ready index without changing the accepted release", async () => {
    installVolumeS3Fixture();
    const name = `api-test-index-integrity-${TEST_SUFFIX}`;
    await syncCatalog(catalog([activeDefinition(name)]));
    const first = requireValue(
      (await readState(name)).body.definition,
      "Expected the historical Definition",
    );
    const currentCandidate = activeDefinition(name, {
      instruction: "Keep the current revision.",
    });
    const currentRelease = await syncCatalog(catalog([currentCandidate]));
    const current = await readState(name);
    // Only infrastructure/old data can corrupt a durable ready row. Scope the
    // fixture to the exact historical artifact created by this test.
    await alterRegisteredVolumeIndexFixture(
      {
        orgId: SYSTEM_ORG_ID,
        storageName: first.artifact.storageName,
        versionId: first.artifact.storageVersion,
        state: "corrupt-hash",
      },
      context.signal,
    );
    context.mocks.s3.send.mockClear();
    const rejected = await syncCatalog(catalog([currentCandidate]));
    expect(rejected.body).toMatchObject({
      outcome: "rejected",
      releaseId: currentRelease.body.releaseId,
      diagnostics: [
        expect.objectContaining({ code: "artifact-preparation-failed" }),
      ],
    });
    expect((await readState(name)).body).toStrictEqual(current.body);
    expect((await readState(name, first.revision)).body.revision).toMatchObject(
      {
        definition: { revision: first.revision },
        artifact: first.artifact,
      },
    );
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("rejects silent deletion and retains identity through retirement and reactivation", async () => {
    installVolumeS3Fixture();
    const name = `api-test-lifecycle-${TEST_SUFFIX}`;
    const initiallyRetired = await syncCatalog(
      catalog([retiredDefinition(name)]),
    );
    expect(initiallyRetired.body).toMatchObject({
      outcome: "rejected",
      releaseId: null,
      diagnostics: [{ code: "unknown-retired-definition" }],
    });

    await syncCatalog(catalog([activeDefinition(name)]));
    const active = (await readState(name)).body.definition;
    const silentDeletion = await syncCatalog(catalog([]));
    expect(silentDeletion.body).toMatchObject({
      outcome: "rejected",
      diagnostics: [
        { code: "missing-released-definition", definitionName: name },
      ],
    });

    const retirement = await syncCatalog(catalog([retiredDefinition(name)]));
    expect(retirement.body.outcome).toBe("accepted");
    const retired = (await readState(name)).body.definition;
    expect(retired).toMatchObject({
      name,
      lifecycle: "retired",
      revision: active?.revision,
      artifact: active?.artifact,
      releasedBlueprintKeys: ["daily"],
    });

    const reactivation = await syncCatalog(
      catalog([
        activeDefinition(name, {
          blueprints: [scheduleBlueprint("daily", "15 9 * * *")],
        }),
      ]),
    );
    expect(reactivation.body.outcome).toBe("accepted");
    const reactivated = (await readState(name)).body.definition;
    expect(reactivated).toMatchObject({
      name,
      lifecycle: "active",
      releasedBlueprintKeys: ["daily"],
    });
    expect(reactivated?.revision).not.toBe(active?.revision);

    const blueprintRemoval = await syncCatalog(
      catalog([activeDefinition(name, { blueprints: [] })]),
    );
    expect(blueprintRemoval.body.outcome).toBe("accepted");
    expect((await readState(name)).body.definition).toMatchObject({
      blueprints: [],
      releasedBlueprintKeys: ["daily"],
    });

    const blueprintRestoration = await syncCatalog(
      catalog([
        activeDefinition(name, { blueprints: [scheduleBlueprint("daily")] }),
      ]),
    );
    expect(blueprintRestoration.body.outcome).toBe("accepted");
    expect((await readState(name)).body.definition).toMatchObject({
      releasedBlueprintKeys: ["daily"],
    });
    expect(
      (await readState(name, active?.revision)).body.revision?.definition
        .revision,
    ).toBe(active?.revision);
  });

  it("serializes concurrent identical syncs into one durable release", async () => {
    installVolumeS3Fixture();
    const name = `api-test-concurrent-${TEST_SUFFIX}`;
    const candidate = catalog([activeDefinition(name)]);
    const [left, right] = await Promise.all([
      syncCatalog(candidate),
      syncCatalog(candidate),
    ]);
    expect([left.body.outcome, right.body.outcome].sort()).toStrictEqual([
      "accepted",
      "unchanged",
    ]);
    expect(left.body.releaseId).toBe(right.body.releaseId);
    expect((await readState(name)).body.counts).toStrictEqual({
      releases: 1,
      revisions: 1,
      storages: 1,
      storageVersions: 1,
    });
  });

  it("rejects a slower stale candidate after a different release activates", async () => {
    const s3 = installVolumeS3Fixture();
    const initial = await syncCatalog(catalog([]));
    const name = `api-test-stale-activation-${TEST_SUFFIX}`;
    const blocked = s3.blockNextPut();
    const slowPromise = syncCatalog(
      catalog([
        activeDefinition(name, {
          blueprints: [scheduleBlueprint("daily", "0 8 * * *")],
        }),
      ]),
    );
    await blocked.started;
    const fast = await syncCatalog(
      catalog([
        activeDefinition(name, {
          blueprints: [scheduleBlueprint("daily", "30 8 * * *")],
        }),
      ]),
    ).finally(blocked.release);
    expect(fast.body.outcome).toBe("accepted");

    const slow = await slowPromise;
    expect(slow.body).toStrictEqual({
      outcome: "rejected",
      releaseId: fast.body.releaseId,
      diagnostics: [{ code: "activation-conflict", path: ["catalog"] }],
    });
    expect(slow.body.releaseId).not.toBe(initial.body.releaseId);

    const state = await readState(name);
    expect(state.body.catalog?.releaseId).toBe(fast.body.releaseId);
    expect(state.body.definition?.blueprints[0]?.desiredState).toMatchObject({
      schedule: { cronExpression: "30 8 * * *" },
    });
    expect(state.body.counts).toStrictEqual({
      releases: 2,
      revisions: 1,
      storages: 1,
      storageVersions: 1,
    });
  });
});
