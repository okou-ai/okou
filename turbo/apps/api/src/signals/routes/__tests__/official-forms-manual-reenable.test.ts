import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomUUID, sign as signData } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import {
  officialWorkflowsContract,
  officialWorkflowInstallationsContract,
} from "@okouai/api-contracts/contracts/official-workflows";
import { cronOfficialWorkflowCatalogContract } from "@okouai/api-contracts/contracts/cron";
import {
  OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
  type OfficialWorkflowSourceCatalog,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createApp } from "../../../app-factory";
import { createDeferredPromise } from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { officialWorkflowRoutes } from "../official-workflows";
import { webhooksGoogleFormsRoutes } from "../webhooks-google-forms";
import { createCronOfficialWorkflowCatalogRoutes } from "../cron-official-workflow-catalog";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import {
  createConnectorBddApi,
  mockGoogleFormsConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { chatEventDisplayText } from "./helpers/chat-event";
const context = testContext();
const workflows = createWorkflowsBddApi(context);
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);
const mocks = createRouteMocks(context);
const FORM_ID = "1FAIpQLScManualReenable" + randomUUID().replaceAll("-", "");
const FORM_URL = "https://docs.google.com/forms/d/" + FORM_ID + "/edit";
const TOPIC = "projects/test/topics/forms";
const AUDIENCE = "https://api.okou.ai/api/webhooks/google-forms";
const EMAIL = "forms-push@test.iam.gserviceaccount.com";
const CRON_SECRET = "forms-manual-reenable-local-analysis-cron";
const BEFORE = "2026-10-13T04:00:00.123456Z";
const CLOSED = "2026-10-13T04:05:00.123456Z";
const RESUME = "2026-10-13T04:10:00.123456Z";
const AFTER = "2026-10-13T04:11:00.123456Z";
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });

beforeEach(() => {
  mockEnv("CRON_SECRET", CRON_SECRET);
  const currentTime = now();
  mockNow(currentTime);
  for (const [name, value] of Object.entries({
    CRON_SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    GOOGLE_FORMS_PUBSUB_TOPIC_NAME: TOPIC,
    GOOGLE_FORMS_PUBSUB_PUSH_AUDIENCE: AUDIENCE,
    GOOGLE_FORMS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: EMAIL,
    SECRETS_KMS_KEY_ID: "alias/okou-secrets-test",
    RUNNER_DEFAULT_GROUP: "vm0/forms-manual-reenable-local-analysis",
  })) {
    mockOptionalEnv(name, value);
  }
  server.use(
    http.get("https://www.googleapis.com/oauth2/v1/certs", () => {
      return HttpResponse.json(
        {
          "forms-manual-reenable-key": keyPair.publicKey.export({
            type: "spki",
            format: "pem",
          }),
        },
        { headers: { "cache-control": "no-cache" } },
      );
    }),
  );
});
function automations() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function catalog(): OfficialWorkflowSourceCatalog {
  return {
    schemaVersion: OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
    definitions: [
      {
        name: "forms-manual-reenable-forms",
        lifecycle: "active",
        workflow: {
          displayName: "Forms responses",
          description: "Local Forms regression catalog",
          instruction: "Process response metadata.",
          files: [{ path: "references/context.md", content: "context\n" }],
        },
        presentation: {
          category: "productivity",
          order: 1,
          marketingCopy: "Process Forms responses",
        },
        blueprints: [
          {
            key: "forms",
            parameters: [
              {
                key: "form-url",
                type: "string",
                format: "url",
                required: false,
                default: FORM_URL,
              },
            ],
            desiredState: {
              kind: "event",
              eventType: "google-forms-response-submitted",
              eventConfig: {
                provider: "google-forms",
                event: "response_submitted",
                formUrl: { parameter: "form-url" },
              },
              autonomyBudget: 4,
            },
          },
        ],
      },
    ],
  };
}

function mockCatalogObjects() {
  const objects = new Map<string, Buffer>();
  const fallback = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key;
      const body = command.input.Body;
      if (!key || (typeof body !== "string" && !(body instanceof Uint8Array))) {
        throw new Error("Expected ordinary S3 publication bytes");
      }
      objects.set(key, Buffer.from(body));
      return Promise.resolve({});
    }
    if (
      command instanceof GetObjectCommand ||
      command instanceof HeadObjectCommand
    ) {
      const body = objects.get(command.input.Key ?? "");
      if (!body) {
        return Promise.reject(
          Object.assign(new Error("S3 object not found"), {
            name: "NoSuchKey",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      if (command instanceof HeadObjectCommand) {
        return Promise.resolve({ ContentLength: body.length });
      }
      return Promise.resolve({
        Body: {
          async *[Symbol.asyncIterator]() {
            yield body;
          },
        },
        ContentLength: body.length,
      });
    }
    if (command instanceof ListObjectsV2Command) {
      return Promise.resolve({
        Contents: [...objects]
          .filter(([key]) => {
            return key.startsWith(command.input.Prefix ?? "");
          })
          .map(([Key, body]) => {
            return { Key, Size: body.length };
          }),
      });
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const object of command.input.Delete?.Objects ?? []) {
        if (object.Key) {
          objects.delete(object.Key);
        }
      }
      return Promise.resolve({});
    }
    if (!fallback) {
      throw new Error("Unexpected external S3 request");
    }
    return fallback(command);
  });
}

function formsProvider() {
  const expireTime = new Date(now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const watches = new Map<string, string>();
  const allWatches = new Map<string, { id: string; token: string }>();
  const seeds: (() => Promise<Response>)[] = [];
  const filters: string[] = [];
  let seed = BEFORE;
  let failStop = false;
  let failSeed = false;
  let pending = false;
  server.use(
    http.get("https://forms.googleapis.com/v1/forms/:formId", ({ params }) => {
      return HttpResponse.json({
        formId: params.formId,
        info: { title: "Boundary survey" },
        publishSettings: {
          publishState: { isPublished: true, isAcceptingResponses: true },
        },
      });
    }),
    http.get(
      "https://forms.googleapis.com/v1/forms/:formId/responses",
      async ({ request }) => {
        const filter = new URL(request.url).searchParams.get("filter");
        if (filter === null) {
          const held = seeds.shift();
          if (held) {
            return await held();
          }
          if (failSeed) {
            return HttpResponse.json(
              { error: { message: "Provider temporarily unavailable" } },
              { status: 500 },
            );
          }
          return HttpResponse.json({
            responses: [
              {
                responseId: "provider-baseline",
                createTime: seed,
                lastSubmittedTime: seed,
              },
            ],
          });
        }
        filters.push(filter);
        const cutoff = filter.replace("timestamp > ", "");
        const candidates = [
          {
            responseId: "closed-period-response",
            createTime: CLOSED,
            lastSubmittedTime: CLOSED,
            respondentEmail: "closed@example.test",
          },
          {
            responseId: "after-resume-response",
            createTime: AFTER,
            lastSubmittedTime: AFTER,
            respondentEmail: "after@example.test",
          },
        ];
        return HttpResponse.json({
          responses: (pending ? candidates : []).filter((x) => {
            return x.lastSubmittedTime > cutoff;
          }),
        });
      },
    ),
    http.get(
      "https://forms.googleapis.com/v1/forms/:formId/watches",
      ({ request }) => {
        const token = request.headers.get("authorization") ?? "";
        return HttpResponse.json({
          watches: [...allWatches.values()]
            .filter((w) => {
              return w.token === token;
            })
            .map((w) => {
              return {
                id: w.id,
                expireTime,
                eventType: "RESPONSES",
                target: { topic: { topicName: TOPIC } },
              };
            }),
        });
      },
    ),
    http.post(
      "https://forms.googleapis.com/v1/forms/:formId/watches",
      ({ request }) => {
        const token = request.headers.get("authorization") ?? "";
        const id = "watch-" + randomUUID();
        watches.set(token, id);
        allWatches.set(id, { id, token });
        return HttpResponse.json({
          id,
          expireTime,
          eventType: "RESPONSES",
          target: { topic: { topicName: TOPIC } },
        });
      },
    ),
    http.delete(
      "https://forms.googleapis.com/v1/forms/:formId/watches/:watchId",
      ({ params }) => {
        if (failStop) {
          return HttpResponse.json(
            { error: { message: "Remote cleanup unavailable" } },
            { status: 500 },
          );
        }
        allWatches.delete(String(params.watchId));
        return HttpResponse.json({});
      },
    ),
  );
  return {
    filters,
    watch(token: string) {
      const id = watches.get("Bearer " + token);
      if (!id) {
        throw new Error("No returned provider watch");
      }
      return id;
    },
    setSeed(value: string) {
      seed = value;
    },
    failStop(value: boolean) {
      failStop = value;
    },
    failSeed(value: boolean) {
      failSeed = value;
    },
    pending(value: boolean) {
      pending = value;
    },
    holdSeed(value: string) {
      const started = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      seeds.push(async () => {
        started.resolve();
        await release.promise;
        return HttpResponse.json({
          responses: [
            {
              responseId: "held-provider-baseline",
              createTime: value,
              lastSubmittedTime: value,
            },
          ],
        });
      });
      return {
        started: started.promise,
        release: () => {
          return release.resolve();
        },
      };
    },
  };
}

async function syncCatalog() {
  const client = (
    await setupApp({
      context,
      routes: createCronOfficialWorkflowCatalogRoutes(catalog()),
      isolatePg: true,
    })
  )(cronOfficialWorkflowCatalogContract);
  return await accept(
    client.sync({ headers: { authorization: "Bearer " + CRON_SECRET } }),
    [200],
  );
}

async function setupOfficial() {
  mockCatalogObjects();
  const provider = formsProvider();
  await syncCatalog();
  const { actor } = await workflows.setupWorkflowOrg({
    timezone: "Asia/Shanghai",
  });
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped owner");
  }
  await runs.ensurePersonalSubscriptionModel(actor);
  await runs.updateUserModelPreference(actor, "claude-fable-5-1");
  const { agentId } = await workflows.createAgent(actor);
  mockGoogleFormsConnectorOAuth({
    subject: actor.userId + "-a",
    accessToken: "account-a",
  });
  await workflows.connectConnector(actor, "google-forms");
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId },
    { [FeatureSwitchKey.OfficialWorkflows]: true },
  );
  const headers = { authorization: "Bearer clerk-session" };
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const installed = await accept(
    setupApp({ context, routes: officialWorkflowRoutes })(
      officialWorkflowsContract,
    ).install({
      headers,
      params: { definitionName: "forms-manual-reenable-forms" },
      body: { agentId, blueprints: [{ blueprintKey: "forms", bindings: [] }] },
    }),
    [201],
  );
  const automation = installed.body.workflow.automations[0];
  const chatThreadId = automation?.chatThreadId;
  if (!automation || !chatThreadId) {
    throw new Error("Expected returned Official automation and thread");
  }
  return {
    actor,
    automation: { ...automation, chatThreadId },
    provider,
    headers,
    workflowId: installed.body.workflow.id,
    agentId,
  };
}

function signedPushToken() {
  const encode = (value: unknown) => {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
  };
  const payload = encode({
    aud: AUDIENCE,
    email: EMAIL,
    email_verified: true,
    exp: Math.floor(now() / 1000) + 600,
    iat: Math.floor(now() / 1000),
    iss: "https://accounts.google.com",
    sub: "provider-push",
  });
  const input =
    encode({ alg: "RS256", kid: "forms-manual-reenable-key", typ: "JWT" }) +
    "." +
    payload;
  return (
    input +
    "." +
    signData("RSA-SHA256", Buffer.from(input), keyPair.privateKey).toString(
      "base64url",
    )
  );
}

async function push(watchId: string) {
  const response = await createApp({
    signal: context.signal,
    routes: webhooksGoogleFormsRoutes,
  }).request("/api/webhooks/google-forms", {
    method: "POST",
    headers: {
      authorization: "Bearer " + signedPushToken(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        messageId: randomUUID(),
        attributes: { formId: FORM_ID, watchId, eventType: "RESPONSES" },
      },
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as unknown;
}

describe("Official Forms manual delivery intervals", () => {
  it.each([false, true])(
    "starts a fresh manual interval after stop, shared watch=%s",
    async (sharedWatch) => {
      const { actor, automation, provider, headers, agentId } =
        await setupOfficial();
      const shared = sharedWatch
        ? await accept(
            automations().create({
              headers,
              params: {
                workflowId: await workflows.createWorkflow(actor, {
                  agentId,
                  name: "shared-forms",
                }),
              },
              body: {
                kind: "event",
                eventType: "google-forms-response-submitted",
                eventConfig: {
                  provider: "google-forms",
                  event: "response_submitted",
                  formUrl: FORM_URL,
                },
              },
            }),
            [201],
          )
        : null;
      provider.failStop(true);
      await accept(
        automations().disable({ headers, params: { id: automation.id } }),
        [200],
      );
      provider.setSeed(RESUME);
      await accept(
        automations().enable({ headers, params: { id: automation.id } }),
        [200],
      );
      if (shared) {
        await accept(
          automations().disable({ headers, params: { id: shared.body.id } }),
          [200],
        );
      }
      provider.pending(true);
      await expect(push(provider.watch("account-a"))).resolves.toMatchObject({
        dispatched: 1,
      });
      await flushWaitUntilForTest();
      const events = await workflows.readThreadEvents(automation.chatThreadId);
      expect(
        events
          .filter((event) => {
            return event.eventType === "input.automation";
          })
          .map(chatEventDisplayText),
      ).toStrictEqual([
        'A new response from after@example.test was submitted to Google Form "Boundary survey".',
      ]);
    },
  );
  it("leaves a genuinely stopped Official automation inactive after provider preparation fails", async () => {
    const { automation, provider, headers } = await setupOfficial();
    await accept(
      automations().disable({ headers, params: { id: automation.id } }),
      [200],
    );
    provider.failSeed(true);
    await accept(
      automations().enable({ headers, params: { id: automation.id } }),
      [400],
    );
    const stopped = await accept(
      automations().get({ headers, params: { id: automation.id } }),
      [200],
    );
    expect(stopped.body).toMatchObject({
      enabled: false,
      official: { intendedEnabled: false },
    });
    provider.failSeed(false);
    provider.setSeed(RESUME);
    await accept(
      automations().enable({ headers, params: { id: automation.id } }),
      [200],
    );
  });
  it("rejects same-clock stale preparation after a repeated manual stop and accepts a fresh enable", async () => {
    const { automation, provider, headers } = await setupOfficial();
    await accept(
      automations().disable({ headers, params: { id: automation.id } }),
      [200],
    );
    const baseline = provider.holdSeed(RESUME);
    const enabling = automations().enable({
      headers,
      params: { id: automation.id },
    });
    await baseline.started;
    await accept(
      automations().disable({ headers, params: { id: automation.id } }),
      [200],
    );
    baseline.release();
    await accept(enabling, [409]);
    const current = await accept(
      automations().get({ headers, params: { id: automation.id } }),
      [200],
    );
    expect(current.body).toMatchObject({
      enabled: false,
      official: { intendedEnabled: false },
    });
    provider.setSeed(RESUME);
    await accept(
      automations().enable({ headers, params: { id: automation.id } }),
      [200],
    );
    provider.pending(true);
    await expect(push(provider.watch("account-a"))).resolves.toMatchObject({
      dispatched: 1,
    });
  });
  it("preserves the already-enabled Official refresh backlog instead of starting a manual interval", async () => {
    const { automation, provider, headers } = await setupOfficial();
    provider.setSeed(RESUME);
    await accept(
      automations().enable({ headers, params: { id: automation.id } }),
      [200],
    );
    provider.pending(true);
    await expect(push(provider.watch("account-a"))).resolves.toMatchObject({
      dispatched: 2,
    });
    await flushWaitUntilForTest();
    const events = await workflows.readThreadEvents(automation.chatThreadId);
    expect(
      events
        .filter((event) => {
          return event.eventType === "input.automation";
        })
        .map(chatEventDisplayText),
    ).toStrictEqual([
      'A new response from closed@example.test was submitted to Google Form "Boundary survey".',
      'A new response from after@example.test was submitted to Google Form "Boundary survey".',
    ]);
  });
});

test("replaces an earlier account-repair baseline only after manual re-enable is prepared", async () => {
  const { actor, automation, provider, headers } = await setupOfficial();
  mockGoogleFormsConnectorOAuth({
    subject: actor.userId + "-b",
    accessToken: "account-b",
  });
  await workflows.connectConnector(actor, "google-forms");
  const accounts = await connectors.listBuiltinConnectorAccounts(
    actor,
    "google-forms",
  );
  const second = accounts.find((account) => {
    return account.externalId === actor.userId + "-b";
  });
  if (!second) {
    throw new Error(
      "Expected second account returned by public connection list",
    );
  }
  const repairBaseline = provider.holdSeed(BEFORE);
  const changingDefault = connectors.setDefaultBuiltinConnectorAccount(
    actor,
    "google-forms",
    second.id,
  );
  await repairBaseline.started;
  const stopped = await accept(
    automations().disable({
      headers,
      params: { id: automation.id },
    }),
    [200],
  );
  expect(stopped.body).toMatchObject({
    enabled: false,
    official: { intendedEnabled: false },
  });
  const manualBaseline = provider.holdSeed(RESUME);
  const enabling = automations().enable({
    headers,
    params: { id: automation.id },
  });
  await manualBaseline.started;
  repairBaseline.release();
  await changingDefault;
  manualBaseline.release();
  await accept(enabling, [200]);
  provider.pending(true);
  const result = await push(provider.watch("account-b"));
  await flushWaitUntilForTest();
  expect(result).toMatchObject({ dispatched: 1 });
  const events = await workflows.readThreadEvents(automation.chatThreadId);
  const delivered = events.filter((event) => {
    return event.eventType === "input.automation";
  });
  expect(delivered.map(chatEventDisplayText)).toStrictEqual([
    'A new response from after@example.test was submitted to Google Form "Boundary survey".',
  ]);
  expect(provider.filters).toContain("timestamp > " + RESUME);
});

test.each(["change default", "delete account"])(
  "keeps manual activation inactive after the owner changes its account: %s",
  async (change) => {
    const { actor, automation, provider, headers } = await setupOfficial();
    mockGoogleFormsConnectorOAuth({
      subject: actor.userId + "-b",
      accessToken: "account-b",
    });
    await workflows.connectConnector(actor, "google-forms");
    const accounts = await connectors.listBuiltinConnectorAccounts(
      actor,
      "google-forms",
    );
    const first = accounts.find((account) => {
      return account.externalId === actor.userId + "-a";
    });
    const second = accounts.find((account) => {
      return account.externalId === actor.userId + "-b";
    });
    if (!first || !second) {
      throw new Error("Expected both public Forms accounts");
    }
    await accept(
      automations().disable({ headers, params: { id: automation.id } }),
      [200],
    );
    const baseline = provider.holdSeed(RESUME);
    const enabling = createApp({
      signal: context.signal,
      routes: workflowAutomationsRoutes,
    }).request(`/api/workflow-automations/${automation.id}/enable`, {
      method: "POST",
      headers,
    });
    await baseline.started;
    if (change === "delete account") {
      await connectors.deleteBuiltinConnectorAccount(
        actor,
        "google-forms",
        first.id,
      );
    } else {
      await connectors.setDefaultBuiltinConnectorAccount(
        actor,
        "google-forms",
        second.id,
      );
    }
    baseline.release();
    const response = await enabling;
    // Deleted-account preparation already fails at the watch FK on main.
    // Both outcomes reject publication; neither may revive the stopped row.
    expect(response.status).toBe(change === "delete account" ? 500 : 409);
    await response.json();
    const current = await accept(
      automations().get({ headers, params: { id: automation.id } }),
      [200],
    );
    expect(current.body).toMatchObject({
      enabled: false,
      official: { intendedEnabled: false },
    });
    provider.setSeed(RESUME);
    await accept(
      automations().enable({ headers, params: { id: automation.id } }),
      [200],
    );
    provider.pending(true);
    await expect(push(provider.watch("account-b"))).resolves.toMatchObject({
      dispatched: 1,
    });
  },
);

test("rejects manual preparation superseded by a public source reconfiguration", async () => {
  const { automation, provider, headers, workflowId } = await setupOfficial();
  await accept(
    automations().disable({ headers, params: { id: automation.id } }),
    [200],
  );
  const baseline = provider.holdSeed(RESUME);
  const enabling = automations().enable({
    headers,
    params: { id: automation.id },
  });
  await baseline.started;
  const nextFormId = FORM_ID + "Replacement";
  await accept(
    setupApp({ context, routes: officialWorkflowRoutes })(
      officialWorkflowInstallationsContract,
    ).reconfigure({
      headers,
      params: { workflowId },
      body: {
        blueprints: [
          {
            blueprintKey: "forms",
            bindings: [
              {
                key: "form-url",
                value:
                  "https://docs.google.com/forms/d/" + nextFormId + "/edit",
              },
            ],
          },
        ],
      },
    }),
    [200],
  );
  baseline.release();
  await accept(enabling, [409]);
  const current = await accept(
    automations().get({ headers, params: { id: automation.id } }),
    [200],
  );
  expect(current.body).toMatchObject({
    enabled: false,
    eventConfig: { form: { id: nextFormId } },
    official: { intendedEnabled: false },
  });
});
