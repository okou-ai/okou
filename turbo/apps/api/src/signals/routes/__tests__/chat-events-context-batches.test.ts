import { createChatConnectorAccessApi } from "./helpers/chat-connector-access";
import { BUILT_IN_SKILLS } from "@okouai/core/built-in-skills";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MODEL_PROVIDER_ENV_PLACEHOLDERS } from "@okouai/api-contracts/contracts/model-providers";
import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import {
  manualHttpCustomConnectorCreateBody,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { readExecutionContentBundle } from "./helpers/execution-content-bundle";
import { createFirewallApi } from "./helpers/api-bdd-firewall";

const context = testContext();
const {
  api,
  connectors,
  entitledNativeChatActor,
  sendChatRun,
  runExecution,
  cancelChatRun,
} = createChatEventsFixture(context);
const MODEL = "claude-fable-5-1";
const misc = createMiscRoutesApi(context);

function codexCredential() {
  const jwt = Buffer.from(
    JSON.stringify({
      exp: Math.floor(now() / 1000) + 7200,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "context-batch-account",
        chatgpt_plan_type: "plus",
      },
    }),
  ).toString("base64url");
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: `e30.${jwt}.test-signature`,
      refresh_token: "context-batch-refresh",
      account_id: "context-batch-account",
      id_token: `e30.${jwt}.test-signature`,
    },
  });
}

async function expectCustomConnectorRegion(
  execution: Awaited<ReturnType<typeof runExecution>>,
  customConnectorId: string,
  region: string,
) {
  const firewall = createFirewallApi(context);
  const entry = execution.execution.firewalls?.find((candidate) => {
    return (
      candidate.kind === "inline" &&
      candidate.customConnectorId === customConnectorId
    );
  });
  if (!entry || entry.kind !== "inline") {
    throw new Error("Expected the selected custom firewall");
  }
  const api = entry.firewall.apis[0];
  if (!api?.id) {
    throw new Error("Expected the selected custom API identity");
  }
  const target = execution.execution.connectorRuntimeTargets.find(
    (candidate) => {
      return (
        candidate.kind === "custom" &&
        candidate.customConnectorId === customConnectorId
      );
    },
  );
  if (!target || target.kind !== "custom") {
    throw new Error("Expected the selected custom runtime target");
  }
  const auth = await firewall.requestFirewallAuth(
    { authorization: `Bearer ${execution.execution.firewallToken}` },
    {
      authHeaders: api.auth.headers ?? {},
      authQuery: api.auth.query,
      matchedFirewall: {
        name: entry.firewall.name,
        apiId: api.id,
        customConnectorId,
        sourceId: entry.sourceId,
        routingVariables: target.baseUrlVars,
      },
    },
    [200],
  );
  expect(auth.body).toMatchObject({
    headers: { Authorization: "Bearer context-batch-custom-secret" },
    query: { region },
  });
}

describe("shared context statement projections through normal sends", () => {
  it.each(["providers", "all"] as const)(
    "preserves %s rowsets in first and continuation sends",
    async (mode) => {
      const { actor, defaultAgentId: agentId } =
        await entitledNativeChatActor();
      const s3 = installWorkflowVolumeS3Fixture(context);
      const hasAgentRows = mode === "all";
      await misc.upsertPersonalModelProvider(
        actor,
        {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: codexCredential() },
        },
        [200, 201],
      );
      await api.updateUserModelPreference(actor, MODEL);
      let customId: string | undefined;
      let customConnectionId: string | undefined;
      let workflowName: string | undefined;
      if (hasAgentRows) {
        mockSlackConnectorOAuth();
        const slack = await connectors.startOauth(actor, "slack", "oauth");
        const state = new URL(slack.authorizationUrl).searchParams.get("state");
        if (!state) {
          throw new Error("Expected Slack authorization state");
        }
        await connectors.completeOauthCallback("slack", {
          code: "batch-slack-code",
          state,
        });
        const custom = await connectors.createCustomConnector(actor, {
          ...manualHttpCustomConnectorCreateBody({
            slug: `_batch-${randomUUID()}`,
            displayName: "Batch custom connector",
            prefixTemplates: ["https://batch.example.test/"],
          }),
          fields: [
            { key: "secret", label: "Secret", kind: "secret", required: true },
            {
              key: "region",
              label: "Region",
              kind: "variable",
              required: true,
            },
          ],
          queryInjections: [
            { name: "region", valueTemplate: "{{variables.region}}" },
          ],
        });
        customId = custom.id;
        const account = await connectors.setCustomConnectorValues(
          actor,
          custom.id,
          [
            {
              key: "secret",
              kind: "secret",
              value: "context-batch-custom-secret",
            },
            { key: "region", kind: "variable", value: "first" },
          ],
        );
        customConnectionId = account.connectionId;
        const workflow = await misc.createWorkflow(
          actor,
          agentId,
          `batch-${randomUUID().slice(0, 8)}`,
          { content: "# Batch skill\nPreserve this selected workflow." },
          [201],
        );
        if (workflow.status !== 201) {
          throw new Error("Expected workflow publication");
        }
        workflowName = workflow.body.name;
        const response = await createChatConnectorAccessApi(
          context,
        ).applyPermissions(actor, {
          target: { kind: "builtin", connectorSlug: "slack" },
          mode: "replace",
          grants: [{ permission: "__unknown__", action: "deny" }],
        });
        expect(response.grants).toContainEqual(
          expect.objectContaining({
            action: "deny",
            permission: "__unknown__",
          }),
        );
      }
      let threadId: string | undefined;
      for (const flow of ["first", "continuation"]) {
        if (customId && flow === "continuation") {
          if (!customConnectionId) {
            throw new Error("Expected the original custom account");
          }
          await connectors.setCustomConnectorValues(
            actor,
            customId,
            [
              {
                key: "secret",
                kind: "secret",
                value: "context-batch-custom-secret",
              },
              { key: "region", kind: "variable", value: flow },
            ],
            { intent: "reconnect", connectionId: customConnectionId },
          );
        }
        const run = await sendChatRun(actor, {
          agentId,
          ...(threadId ? { threadId } : {}),
          prompt: `${mode} ${flow}`,
        });
        threadId = run.threadId;
        const execution = await runExecution(run.runId);
        expect(execution.execution.modelUsageProvider).toBe(MODEL);
        expect(execution.execution.firewalls).toContainEqual({
          kind: "builtin",
          name: "model-provider:claude-code-oauth-token",
        });
        expect(
          execution.execution.networkPolicies?.[
            "model-provider:claude-code-oauth-token"
          ],
        ).toStrictEqual({
          allow: [],
          deny: [],
          ask: [],
          unknownPolicy: "allow",
        });
        expect(execution.execution.environment?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
          MODEL_PROVIDER_ENV_PLACEHOLDERS.CLAUDE_CODE_OAUTH_TOKEN,
        );
        const targets = execution.execution.connectorRuntimeTargets;
        if (customId) {
          expect(targets).toContainEqual(
            expect.objectContaining({
              kind: "custom",
              customConnectorId: customId,
            }),
          );
          expect(targets).toContainEqual(
            expect.objectContaining({
              kind: "builtin",
              connectorSlug: "slack",
            }),
          );
          expect(
            execution.execution.networkPolicies?.slack?.unknownPolicy,
          ).toBe("deny");
          await expectCustomConnectorRegion(execution, customId, flow);
        } else {
          expect(targets).toStrictEqual([]);
        }
        const skills = execution.execution.contentBundles.skills;
        if (workflowName) {
          const skill = skills.find((item) => {
            return item.mountPath.endsWith(`/${workflowName}`);
          });
          if (!skill) {
            throw new Error("Expected the selected Workflow bundle");
          }
          expect(
            readExecutionContentBundle(s3.objects, skill)
              .get("SKILL.md")
              ?.toString(),
          ).toContain("Preserve this selected workflow.");
        } else {
          expect(
            skills.map((skill) => {
              return skill.mountPath.split("/").at(-1);
            }),
          ).toStrictEqual(BUILT_IN_SKILLS);
        }
        await cancelChatRun(actor, run.runId, execution.sandboxHeaders);
      }
    },
  );
});
