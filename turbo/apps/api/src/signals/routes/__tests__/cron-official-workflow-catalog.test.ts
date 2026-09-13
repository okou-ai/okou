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
  return await accept(
    syncClient(candidate).sync({ headers: cronHeaders() }),
    [200],
  );
}

async function syncDeployedCatalog() {
  return await accept(
    setupApp({ context, routes: cronOfficialWorkflowCatalogRoutes })(
      cronOfficialWorkflowCatalogContract,
    ).sync({ headers: cronHeaders() }),
    [200],
  );
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

  it("uses one canonical effective event configuration for identity", async () => {
    installVolumeS3Fixture();
    const name = `api-test-event-canonical-${TEST_SUFFIX}`;
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
    ).toMatchObject({
      eventConfig: { runStatuses: ["completed", "failed"] },
    });

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

    const changed = await syncCatalog(
      catalog([
        activeDefinition(name, {
          blueprints: [
            calendarBlueprint("calendar", "secondary"),
            reorderedSet,
          ],
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

  it("repairs missing immutable objects without changing accepted identity", async () => {
    const s3 = installVolumeS3Fixture();
    const name = `api-test-repair-${TEST_SUFFIX}`;
    await syncCatalog(catalog([activeDefinition(name)]));
    const initial = (await readState(name)).body.definition;
    const archiveKey = [...s3.objects.keys()].find((key) => {
      return key.endsWith("/archive.tar.gz");
    });
    const manifestKey = [...s3.objects.keys()].find((key) => {
      return key.endsWith("/manifest.json");
    });
    expect(archiveKey).toBeDefined();
    expect(manifestKey).toBeDefined();
    if (!archiveKey || !manifestKey) {
      throw new Error("Expected both immutable volume objects");
    }

    s3.objects.delete(archiveKey);
    s3.clearWrites();
    const archiveRepair = await syncCatalog(catalog([activeDefinition(name)]));
    expect(archiveRepair.body).toStrictEqual({
      outcome: "unchanged",
      releaseId: expect.any(String),
      diagnostics: [],
    });
    expect(s3.objects.has(archiveKey)).toBeTruthy();
    expect(s3.writes).toContain(archiveKey);

    s3.objects.delete(manifestKey);
    s3.clearWrites();
    const manifestRepair = await syncCatalog(catalog([activeDefinition(name)]));
    expect(manifestRepair.body.outcome).toBe("unchanged");
    expect(s3.objects.has(manifestKey)).toBeTruthy();
    expect(s3.writes).toContain(manifestKey);

    const repaired = await readState(name);
    expect(repaired.body.definition).toMatchObject({
      revision: initial?.revision,
      artifact: initial?.artifact,
    });
    expect(repaired.body.counts).toStrictEqual({
      releases: 1,
      revisions: 1,
      storages: 1,
      storageVersions: 1,
    });
  });

  it("repairs the retained exact artifact while accepting and repeating retirement", async () => {
    const s3 = installVolumeS3Fixture();
    const name = `api-test-retired-repair-${TEST_SUFFIX}`;
    await syncCatalog(catalog([activeDefinition(name)]));
    const active = (await readState(name)).body.definition;
    const archiveKey = [...s3.objects.keys()].find((key) => {
      return key.endsWith("/archive.tar.gz");
    });
    const manifestKey = [...s3.objects.keys()].find((key) => {
      return key.endsWith("/manifest.json");
    });
    expect(archiveKey).toBeDefined();
    expect(manifestKey).toBeDefined();
    if (!archiveKey || !manifestKey) {
      throw new Error("Expected both immutable volume objects");
    }

    s3.objects.delete(archiveKey);
    s3.clearWrites();
    const retirement = await syncCatalog(catalog([retiredDefinition(name)]));
    expect(retirement.body.outcome).toBe("accepted");
    expect(s3.objects.has(archiveKey)).toBeTruthy();
    expect(s3.writes).toContain(archiveKey);
    expect((await readState(name)).body.definition).toMatchObject({
      lifecycle: "retired",
      revision: active?.revision,
      artifact: active?.artifact,
    });

    s3.objects.delete(manifestKey);
    s3.clearWrites();
    const repeatedRetirement = await syncCatalog(
      catalog([retiredDefinition(name)]),
    );
    expect(repeatedRetirement.body).toMatchObject({
      outcome: "unchanged",
      releaseId: retirement.body.releaseId,
      diagnostics: [],
    });
    expect(s3.objects.has(manifestKey)).toBeTruthy();
    expect(s3.writes).toContain(manifestKey);

    const repaired = await readState(name);
    expect(repaired.body.definition).toMatchObject({
      lifecycle: "retired",
      revision: active?.revision,
      artifact: active?.artifact,
    });
    expect(repaired.body.counts).toStrictEqual({
      releases: 2,
      revisions: 1,
      storages: 1,
      storageVersions: 1,
    });
  });

  it("repairs every durable historical exact revision", async () => {
    const s3 = installVolumeS3Fixture();
    const name = `api-test-historical-repair-${TEST_SUFFIX}`;
    await syncCatalog(catalog([activeDefinition(name)]));
    const first = (await readState(name)).body.definition;
    expect(first?.revision).toBeDefined();
    expect(first?.artifact.storageVersion).toBeDefined();

    const currentCandidate = activeDefinition(name, {
      instruction: "Use the second durable revision.",
    });
    await syncCatalog(catalog([currentCandidate]));
    const second = (await readState(name)).body.definition;
    expect(second?.revision).not.toBe(first?.revision);
    const firstArchiveKey = [...s3.objects.keys()].find((key) => {
      return (
        key.includes(`/${first?.artifact.storageVersion}/`) &&
        key.endsWith("/archive.tar.gz")
      );
    });
    expect(firstArchiveKey).toBeDefined();
    if (!firstArchiveKey || !first?.revision || !second?.revision) {
      throw new Error("Expected two exact revisions and the first archive");
    }

    s3.objects.delete(firstArchiveKey);
    s3.clearWrites();
    const repair = await syncCatalog(catalog([currentCandidate]));
    expect(repair.body.outcome).toBe("unchanged");
    expect(s3.objects.has(firstArchiveKey)).toBeTruthy();
    expect(s3.writes).toContain(firstArchiveKey);

    const repaired = await readState(name);
    expect(repaired.body.definition).toMatchObject({
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
    expect(repaired.body.counts).toStrictEqual({
      releases: 2,
      revisions: 2,
      storages: 1,
      storageVersions: 2,
    });
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
