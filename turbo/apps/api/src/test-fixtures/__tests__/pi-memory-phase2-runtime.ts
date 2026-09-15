import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { executionContextSchema } from "@okouai/api-contracts/contracts/runners";
import { materializePiAgentModelConfig } from "@okouai/pi-agent-runtime";
import { runPiMemoryPhase2MountedConsolidation } from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { expect, onTestFinished } from "vitest";
import { createAppWithRoutes } from "../../app-factory-core";
import type { TestContext } from "../../__tests__/test-context";
import { server } from "../../mocks/server";
import { runnersRoutes } from "../../signals/routes/runners";
import {
  createFirewallApi,
  secretTemplate,
} from "../../signals/routes/__tests__/helpers/api-bdd-firewall";

export async function claimPhase2Execution(
  context: TestContext,
  runId: string,
) {
  const response = await createAppWithRoutes({
    signal: context.signal,
    routes: runnersRoutes,
  }).request(`/api/runners/jobs/${runId}/claim`, {
    method: "POST",
    headers: {
      authorization:
        "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      runnerIdentity: { runnerId: randomUUID(), heartbeatGeneration: 1 },
      capabilities: { piModelConfigGenerations: [1, 2, 3] },
    }),
  });
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return executionContextSchema.parse(body);
}

export async function phase2RuntimeModel(
  context: TestContext,
  execution: Awaited<ReturnType<typeof claimPhase2Execution>>,
) {
  if (!execution.piModelConfig || !execution.encryptedSecrets) {
    throw new Error("Missing private runtime context");
  }
  const encryptedSecrets = execution.encryptedSecrets;
  return await materializePiAgentModelConfig({
    config: execution.piModelConfig,
    target: "direct",
    async resolveCredential(binding) {
      const auth = await createFirewallApi(context).requestFirewallAuth(
        { authorization: `Bearer ${execution.sandboxToken}` },
        {
          encryptedSecrets,
          authHeaders: {
            "x-fixture-value": secretTemplate(binding.secretName),
          },
          secretConnectorMap: execution.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            execution.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      if (auth.status !== 200) {
        throw new Error("Credential unavailable");
      }
      const value = auth.body.headers["x-fixture-value"];
      if (!value) {
        throw new Error("Missing exact credential");
      }
      return value;
    },
  });
}

function maintenanceSse(index: number) {
  const tool = index < 2;
  const item = tool
    ? {
        type: "function_call",
        id: `fc_${index}`,
        call_id: `call_${index}`,
        name: "phase2_write",
        arguments: JSON.stringify({
          path: index === 0 ? "memory/MEMORY.md" : "memory/memory_summary.md",
          content:
            index === 0
              ? "# Task Group: source\n"
              : "v1\n## User Profile\n- source\n",
        }),
        status: "completed",
      }
    : {
        type: "message",
        id: "msg",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Maintained", annotations: [] }],
      };
  const response = {
    id: `resp_${index}`,
    object: "response",
    status: "completed",
    end_turn: !tool,
    output: [item],
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      total_tokens: 13,
      input_tokens_details: { cached_tokens: 2 },
    },
  };
  return [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: tool
        ? { ...item, arguments: "", status: "in_progress" }
        : { ...item, content: [], status: "in_progress" },
    },
    tool
      ? {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: item.id,
          delta: item.arguments,
        }
      : {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "Maintained",
        },
    ...(tool
      ? [
          {
            type: "response.function_call_arguments.done",
            output_index: 0,
            item_id: item.id,
            arguments: item.arguments,
          },
        ]
      : []),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]
    .map((event) => {
      return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

export async function executePhase2Runtime(
  context: TestContext,
  runId: string,
  options: {
    failure?: boolean;
    noDiff?: boolean;
    baseFiles?: readonly { path: string; content: string }[];
  } = {},
) {
  const execution = await claimPhase2Execution(context, runId);
  const maintenance = execution.piLaunchConfig?.maintenance;
  if (!maintenance) {
    throw new Error("Missing claimed selection");
  }
  const model = await phase2RuntimeModel(context, execution);
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  server.use(
    http.post(
      model.provider === "openai-codex"
        ? "https://chatgpt.com/backend-api/codex/responses"
        : `${model.baseUrl}/responses`,
      async ({ request }) => {
        requests.push({
          url: request.url,
          headers: request.headers,
          body: JSON.parse(
            (request.headers.get("content-encoding") === "zstd"
              ? zstdDecompressSync(Buffer.from(await request.arrayBuffer()))
              : Buffer.from(await request.arrayBuffer())
            ).toString("utf8"),
          ) as unknown,
        });
        if (options.failure) {
          return HttpResponse.json(
            { error: { message: "Provider unavailable" } },
            { status: 400 },
          );
        }
        // Let the native SSE parser consume EOF before its early-completion
        // cancellation, so the intercepted response tee is fully drained.
        const stream = maintenanceSse(requests.length - 1);
        return new HttpResponse(
          model.provider === "openai-codex" ? stream.trimEnd() : stream,
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    ),
  );
  const memoryRoot = await mkdtemp(join(tmpdir(), "phase2-source-"));
  onTestFinished(async () => {
    await rm(memoryRoot, { recursive: true, force: true });
  });
  for (const file of options.baseFiles ?? []) {
    const path = join(memoryRoot, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
  const args = {
    memoryRoot,
    memoryStorageId: maintenance.memoryStorageId,
    claimedBaseVersionId: maintenance.claimedBaseVersionId,
    selectionDigest: maintenance.selectionDigest,
    selected: maintenance.selected.map((entry) => {
      return {
        ...entry,
        sourceCompletedAt: new Date(entry.sourceCompletedAt),
      };
    }),
    model,
  };
  if (options.failure) {
    await expect(
      runPiMemoryPhase2MountedConsolidation(args, context.signal),
    ).rejects.toThrow("Pi memory Phase 2 model request failed.");
  } else {
    await expect(
      runPiMemoryPhase2MountedConsolidation(args, context.signal),
    ).resolves.toMatchObject({
      status: options.noDiff ? "no_diff" : "prepared",
    });
  }
  return { execution, model, requests };
}
