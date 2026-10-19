import { randomUUID } from "node:crypto";

import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { cronOfficialWorkflowCatalogContract } from "@okouai/api-contracts/contracts/cron";
import {
  OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
  type OfficialWorkflowBlueprint,
  type OfficialWorkflowSourceCatalog,
  type OfficialWorkflowSourceDefinition,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { createDeferredPromise } from "../../utils";
import {
  createCronOfficialWorkflowCatalogRoutes,
  cronOfficialWorkflowCatalogRoutes,
} from "../cron-official-workflow-catalog";

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
    schemaVersion: OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
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

async function syncClient(candidate: unknown) {
  const app = await setupApp({
    context,
    routes: createCronOfficialWorkflowCatalogRoutes(candidate),
    isolatePg: true,
  });
  return app(cronOfficialWorkflowCatalogContract);
}

async function syncCatalog(candidate: unknown) {
  return await accept(
    (await syncClient(candidate)).sync({ headers: cronHeaders() }),
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
    (await syncClient(candidate)).sync({
      headers: cronHeaders("wrong-secret"),
    }),
    [401],
  );
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

describe("Official Workflow catalog release boundary", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockEnv(
      "R2_USER_STORAGES_BUCKET_NAME",
      `official-workflow-catalog-test-${randomUUID()}`,
    );
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
  });

  it("accepts the deployed catalog over a released Connector Doctor and republishes it without rewrites", async () => {
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

    const first = await syncDeployedCatalog();
    expect(first.body).toMatchObject({
      outcome: "accepted",
      diagnostics: [],
    });
    expect(s3.objects.size).toBe(8);

    s3.clearWrites();
    const second = await syncDeployedCatalog();
    expect(second.body).toMatchObject({
      outcome: "unchanged",
      releaseId: first.body.releaseId,
      diagnostics: [],
    });
    expect(s3.writes).toStrictEqual([]);
  });

  it("treats reordered input as unchanged and skips artifact writes for presentation-only changes", async () => {
    const s3 = installVolumeS3Fixture();
    const name = `api-test-fingerprints-${TEST_SUFFIX}`;
    const daily = scheduleBlueprint("daily");
    const hourly = loopBlueprint("hourly");
    const initial = activeDefinition(name, { blueprints: [daily, hourly] });
    const initialRelease = await syncCatalog(catalog([initial]));

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
      releaseId: initialRelease.body.releaseId,
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

  it("rejects the complete invalid candidate, duplicates, and non-canonical input", async () => {
    installVolumeS3Fixture();
    const name = `api-test-validation-${TEST_SUFFIX}`;
    const baselineCatalog = catalog([activeDefinition(name)]);
    const accepted = await syncCatalog(baselineCatalog);
    const acceptedReleaseId = accepted.body.releaseId;

    const unknownFieldName = `api-test-invalid-${TEST_SUFFIX}`;
    const invalidDefinition = {
      ...activeDefinition(unknownFieldName),
      unknownField: "must fail closed",
    };
    const invalid = await syncCatalog({
      schemaVersion: OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
      definitions: [activeDefinition(name), invalidDefinition],
    });
    expect(invalid.body).toMatchObject({
      outcome: "rejected",
      releaseId: acceptedReleaseId,
      diagnostics: [{ code: "invalid-candidate" }],
    });

    const invalidName = await syncCatalog({
      schemaVersion: OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
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
      schemaVersion: OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
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

    const runtimeSetting = await syncCatalog({
      schemaVersion: OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
      definitions: [
        {
          ...activeDefinition(name),
          blueprints: [
            { ...scheduleBlueprint("daily"), runtime: { resultEmail: false } },
          ],
        },
      ],
    });
    expect(runtimeSetting.body).toMatchObject({
      outcome: "rejected",
      releaseId: acceptedReleaseId,
      diagnostics: [{ code: "invalid-candidate" }],
    });

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
      schemaVersion: OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
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
  });

  it("keeps the previous release when later artifact preparation fails", async () => {
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

    const retried = await syncCatalog(
      catalog([activeDefinition(alpha), activeDefinition(beta)]),
    );
    expect(retried.body.outcome).toBe("accepted");
  });

  it("reuses registered objects without changing the accepted identity", async () => {
    installVolumeS3Fixture();
    const name = `api-test-reuse-${TEST_SUFFIX}`;
    await syncCatalog(catalog([activeDefinition(name)]));
    context.mocks.s3.send.mockClear();
    const repeated = await syncCatalog(catalog([activeDefinition(name)]));
    expect(repeated.body.outcome).toBe("unchanged");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("retires and repeats sync without touching stored objects", async () => {
    installVolumeS3Fixture();
    const name = `api-test-retired-reuse-${TEST_SUFFIX}`;
    await syncCatalog(catalog([activeDefinition(name)]));
    context.mocks.s3.send.mockClear();
    const retirement = await syncCatalog(catalog([retiredDefinition(name)]));
    expect(retirement.body.outcome).toBe("accepted");
    const repeated = await syncCatalog(catalog([retiredDefinition(name)]));
    expect(repeated.body.outcome).toBe("unchanged");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("keeps the current revision stable without probing or rewriting objects", async () => {
    installVolumeS3Fixture();
    const name = `api-test-historical-reuse-${TEST_SUFFIX}`;
    await syncCatalog(catalog([activeDefinition(name)]));
    const currentCandidate = activeDefinition(name, {
      instruction: "Use the second durable revision.",
    });
    await syncCatalog(catalog([currentCandidate]));
    context.mocks.s3.send.mockClear();
    const repeated = await syncCatalog(catalog([currentCandidate]));
    expect(repeated.body.outcome).toBe("unchanged");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("restores the A release through A-B-A and repeated publication", async () => {
    installVolumeS3Fixture();
    const name = `api-test-index-aba-${TEST_SUFFIX}`;
    const firstCandidate = activeDefinition(name);
    const firstRelease = await syncCatalog(catalog([firstCandidate]));
    await syncCatalog(
      catalog([activeDefinition(name, { instruction: "Publish revision B." })]),
    );

    context.mocks.s3.send.mockClear();
    const reverted = await syncCatalog(catalog([firstCandidate]));
    expect(reverted.body).toMatchObject({
      outcome: "accepted",
      releaseId: firstRelease.body.releaseId,
    });
    expect((await syncCatalog(catalog([firstCandidate]))).body.outcome).toBe(
      "unchanged",
    );
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("rejects silent deletion and unknown retirement, then accepts retirement and reactivation", async () => {
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
    const silentDeletion = await syncCatalog(catalog([]));
    expect(silentDeletion.body).toMatchObject({
      outcome: "rejected",
      diagnostics: [
        { code: "missing-released-definition", definitionName: name },
      ],
    });

    const retirement = await syncCatalog(catalog([retiredDefinition(name)]));
    expect(retirement.body.outcome).toBe("accepted");

    const reactivation = await syncCatalog(
      catalog([
        activeDefinition(name, {
          blueprints: [scheduleBlueprint("daily", "15 9 * * *")],
        }),
      ]),
    );
    expect(reactivation.body.outcome).toBe("accepted");

    const blueprintRemoval = await syncCatalog(
      catalog([activeDefinition(name, { blueprints: [] })]),
    );
    expect(blueprintRemoval.body.outcome).toBe("accepted");

    const blueprintRestoration = await syncCatalog(
      catalog([
        activeDefinition(name, { blueprints: [scheduleBlueprint("daily")] }),
      ]),
    );
    expect(blueprintRestoration.body.outcome).toBe("accepted");
  });

  it("serializes concurrent identical syncs into one accepted release", async () => {
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
  });
});
