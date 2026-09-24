import { randomUUID } from "node:crypto";
import { MODEL_PROVIDER_ENV_PLACEHOLDERS } from "@okouai/api-contracts/contracts/model-providers";
import {
  modelProviderConnectionsByIdContract,
  modelProviderConnectionsMainContract,
  type CreateModelProviderConnectionRequest,
} from "@okouai/api-contracts/contracts/model-provider-gateways";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { modelProviderGatewayRoutes } from "../model-provider-gateways";

const context = testContext();
const mocks = createRouteMocks(context);
const chatCallbacks = createChatCallbacksApi(context);
const chat = createChatFilesBddApi(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function useSession(role: "org:admin" | "org:member" = "org:admin") {
  const orgId = `org_gateway_${randomUUID()}`;
  const userId = `user_gateway_${randomUUID()}`;
  mocks.clerk.session(userId, orgId, role);
  return { orgId, userId };
}

function mainClient() {
  return setupApp({ context, routes: modelProviderGatewayRoutes })(
    modelProviderConnectionsMainContract,
  );
}

function byIdClient() {
  return setupApp({ context, routes: modelProviderGatewayRoutes })(
    modelProviderConnectionsByIdContract,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runContextSnapshotForRun(runId: string): Record<string, unknown> {
  for (const [dataset, events] of context.mocks.axiom.ingest.mock.calls) {
    if (dataset !== "run-context" || !Array.isArray(events)) {
      continue;
    }
    const snapshot = events.find((event) => {
      return isRecord(event) && event.runId === runId;
    });
    if (isRecord(snapshot)) {
      return snapshot;
    }
  }
  throw new Error(`Expected a run-context snapshot for ${runId}`);
}

describe("custom model provider gateway routes", () => {
  it("requires authentication and admin access for mutations", async () => {
    const unauthenticated = await accept(
      mainClient().create({
        headers: {},
        body: {
          displayName: "Gateway",
          secret: "secret",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {},
            },
          ],
        },
      }),
      [401],
    );
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    useSession("org:member");
    const forbidden = await accept(
      mainClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Gateway",
          secret: "secret",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {},
            },
          ],
        },
      }),
      [403],
    );
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
    const forbiddenList = await accept(
      mainClient().list({ headers: authHeaders() }),
      [403],
    );
    expect(forbiddenList.body.error.code).toBe("FORBIDDEN");
  });

  it("creates, normalizes, updates, lists, and deletes a connection", async () => {
    useSession();
    const created = await accept(
      mainClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Company Gateway",
          secret: "top-secret",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com/anthropic/v1/messages/",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {
                "claude-sonnet-5": "company-sonnet",
              },
            },
            {
              protocol: "openai-responses",
              apiBaseUrl: "https://gateway.example.com/openai/v1/responses/",
              authHeaderName: "x-api-key",
              authHeaderTemplate: "{{secret}}",
              modelMappings: {
                "gpt-5.6-sol": "company-codex",
              },
            },
          ],
        },
      }),
      [201],
    );

    expect(created.body).not.toHaveProperty("secret");
    expect(created.body.displayName).toBe("Company Gateway");
    expect(created.body.surfaces).toHaveLength(2);
    expect(created.body.surfaces).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          protocol: "anthropic-messages",
          apiBaseUrl: "https://gateway.example.com/anthropic",
        }),
        expect.objectContaining({
          protocol: "openai-responses",
          apiBaseUrl: "https://gateway.example.com/openai/v1",
        }),
      ]),
    );

    const messages = created.body.surfaces.find((surface) => {
      return surface.protocol === "anthropic-messages";
    });
    if (!messages) {
      throw new Error("Expected Messages surface");
    }
    const updated = await accept(
      byIdClient().update({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: {
          displayName: "Renamed Gateway",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com/new-anthropic",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {
                "claude-sonnet-5": "company-sonnet-v2",
              },
            },
          ],
        },
      }),
      [200],
    );

    expect(updated.body.displayName).toBe("Renamed Gateway");
    expect(updated.body.surfaces).toHaveLength(1);
    expect(updated.body.surfaces[0]).toMatchObject({
      id: messages.id,
      protocol: "anthropic-messages",
      apiBaseUrl: "https://gateway.example.com/new-anthropic",
    });

    const listed = await accept(
      mainClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(listed.body.connections).toStrictEqual([
      expect.objectContaining({ id: created.body.id }),
    ]);

    await accept(
      byIdClient().delete({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [204],
    );
    const afterDelete = await accept(
      mainClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(afterDelete.body.connections).toStrictEqual([]);
  });

  it.each<{
    name: string;
    surface: CreateModelProviderConnectionRequest["surfaces"][number];
  }>([
    {
      name: "non-HTTPS base URL",
      surface: {
        protocol: "anthropic-messages",
        apiBaseUrl: "http://gateway.example.com",
        authHeaderName: "Authorization",
        authHeaderTemplate: "Bearer {{secret}}",
        modelMappings: {},
      },
    },
    {
      name: "protected auth header",
      surface: {
        protocol: "anthropic-messages",
        apiBaseUrl: "https://gateway.example.com",
        authHeaderName: "Host",
        authHeaderTemplate: "{{secret}}",
        modelMappings: {},
      },
    },
    {
      name: "missing secret placeholder",
      surface: {
        protocol: "anthropic-messages",
        apiBaseUrl: "https://gateway.example.com",
        authHeaderName: "Authorization",
        authHeaderTemplate: "Bearer static",
        modelMappings: {},
      },
    },
    {
      name: "retired GPT 5.5 model mapping",
      surface: {
        protocol: "openai-responses",
        apiBaseUrl: "https://gateway.example.com",
        authHeaderName: "Authorization",
        authHeaderTemplate: "Bearer {{secret}}",
        modelMappings: { "gpt-5.5": "old-deployment" },
      },
    },
    {
      name: "incompatible model mapping",
      surface: {
        protocol: "anthropic-messages",
        apiBaseUrl: "https://gateway.example.com",
        authHeaderName: "Authorization",
        authHeaderTemplate: "Bearer {{secret}}",
        modelMappings: { "gpt-5.6-sol": "openai/gpt-5.6-sol" },
      },
    },
    {
      name: "retired GPT 5.5 upstream behind an active model mapping",
      surface: {
        protocol: "openai-responses",
        apiBaseUrl: "https://gateway.example.com",
        authHeaderName: "Authorization",
        authHeaderTemplate: "Bearer {{secret}}",
        modelMappings: { "gpt-5.6-sol": "openai/gpt-5.5" },
      },
    },
  ])("rejects $name", async ({ surface }) => {
    useSession();
    const response = await accept(
      mainClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Invalid Gateway",
          secret: "secret",
          surfaces: [surface],
        },
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("compiles a mapped gateway into the runner environment and inline firewall", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    bdd.acceptAgentStorageWrites();
    chatCallbacks.acceptChatObjectStorage();
    chatCallbacks.disableVapid();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Custom gateway runtime",
      visibility: "private",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");

    const created = await accept(
      mainClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Runtime Gateway",
          secret: "runtime-gateway-secret",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com/anthropic",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {
                "claude-fable-5-1": "company-fable-production",
              },
            },
            {
              protocol: "openai-responses",
              apiBaseUrl: "https://gateway.example.com/openai/v1",
              authHeaderName: "x-api-key",
              authHeaderTemplate: "{{secret}}",
              modelMappings: {
                "gpt-6-astra": "company-gpt-production",
              },
            },
          ],
        },
      }),
      [201],
    );
    const messagesSurface = created.body.surfaces.find((surface) => {
      return surface.protocol === "anthropic-messages";
    });
    const responsesSurface = created.body.surfaces.find((surface) => {
      return surface.protocol === "openai-responses";
    });
    if (!messagesSurface || !responsesSurface) {
      throw new Error("Expected both custom gateway surfaces");
    }
    await runs.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        isDefault: true,
        defaultProviderType: "custom-anthropic-messages",
        credentialScope: "org",
        modelProviderId: null,
        modelProviderSurfaceId: messagesSurface.id,
      },
    ]);

    const sent = await chat.requestSendEvent(
      actor,
      {
        clientEventId: randomUUID(),
        agentId: agent.agentId,
        prompt: "exercise the custom gateway",
        model: "claude-fable-5-1",
      },
      [201],
    );
    if ("error" in sent.body) {
      throw new Error("Expected the custom gateway chat send to succeed");
    }
    const runId = sent.body.runId;
    if (!runId) {
      throw new Error("Expected the custom gateway chat send to create a run");
    }
    await runs.heartbeatRunner(runnerGroup);
    const claim = await runs.claimRunnerJob(runId);

    expect(claim.cliAgentType).toBe("claude-code");
    expect(claim.environment).toMatchObject({
      ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic",
      ANTHROPIC_MODEL: "company-fable-production",
    });
    const firewallName = `model-provider-surface:${messagesSurface.id}`;
    const firewall = claim.firewalls?.find((entry) => {
      return entry.kind === "inline" && entry.firewall.name === firewallName;
    });
    expect(firewall).toMatchObject({
      kind: "inline",
      firewall: {
        name: firewallName,
        apis: [
          {
            base: "https://gateway.example.com/anthropic/v1/messages",
            hostPolicy: { kind: "publicDestination" },
            auth: {
              headers: {
                Authorization: `Bearer \${{ secrets.OKOU_MODEL_PROVIDER_API_KEY }}`,
              },
            },
          },
        ],
      },
    });
    // This suite's sole telemetry assertion verifies redaction; the claim
    // above verifies the actual Runner firewall through its production API.
    expect(JSON.stringify(runContextSnapshotForRun(runId))).not.toContain(
      "runtime-gateway-secret",
    );
    expect(claim.secretValues).not.toContain("runtime-gateway-secret");

    await runs.requestCancelRun(actor, runId, [200]);

    await runs.updateOrgModelPolicies(actor, [
      {
        model: "gpt-6-astra",
        isDefault: true,
        defaultProviderType: "custom-openai-responses",
        credentialScope: "org",
        modelProviderId: null,
        modelProviderSurfaceId: responsesSurface.id,
      },
    ]);
    const codexSent = await chat.requestSendEvent(
      actor,
      {
        clientEventId: randomUUID(),
        agentId: agent.agentId,
        prompt: "exercise the custom Responses gateway",
        model: "gpt-6-astra",
      },
      [201],
    );
    if ("error" in codexSent.body) {
      throw new Error(
        "Expected the custom Responses gateway chat send to succeed",
      );
    }
    const codexRunId = codexSent.body.runId;
    if (!codexRunId) {
      throw new Error(
        "Expected the custom Responses gateway chat send to create a run",
      );
    }
    await runs.heartbeatRunner(runnerGroup);
    const codexClaim = await runs.claimRunnerJob(codexRunId);

    expect(codexClaim.cliAgentType).toBe("codex");
    expect(codexClaim.environment).toMatchObject({
      OPENAI_BASE_URL: "https://gateway.example.com/openai/v1",
      OPENAI_MODEL: "company-gpt-production",
    });
    expect(codexClaim.codexRuntimeConfig).toMatchObject({
      providerId: `gateway_${responsesSurface.id.replaceAll("-", "")}`,
      baseUrl: "https://gateway.example.com/openai/v1",
      envKey: "OPENAI_API_KEY",
      httpHeaders: {
        "x-api-key": MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
      },
      requiresOpenaiAuth: false,
      wireApi: "responses",
    });
    expect(codexClaim.codexRuntimeConfig?.modelCatalog).toBeUndefined();
    expect(codexClaim.environment?.OPENAI_API_KEY).toBe(
      MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
    );
    const responsesFirewallName = `model-provider-surface:${responsesSurface.id}`;
    expect(
      codexClaim.firewalls?.find((entry) => {
        return (
          entry.kind === "inline" &&
          entry.firewall.name === responsesFirewallName
        );
      }),
    ).toMatchObject({
      kind: "inline",
      firewall: {
        name: responsesFirewallName,
        apis: [
          {
            base: "https://gateway.example.com/openai/v1/responses",
            auth: {
              headers: {
                "x-api-key": `\${{ secrets.OKOU_MODEL_PROVIDER_API_KEY }}`,
              },
            },
          },
        ],
      },
    });
    expect(codexClaim.secretValues).not.toContain("runtime-gateway-secret");

    await runs.requestCancelRun(actor, codexRunId, [200]);
  }, 15_000);
});
