import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "../../../turbo/packages/api-contracts/src/contracts/chat-event-schema-version";

import { authHeadersForToken } from "./onboarding";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled", "timeout"]);

export interface OwnedWssRun {
  readonly runId: string;
  readonly threadId: string;
  readonly runnerId: string;
  readonly hostname: string;
  readonly heartbeatGeneration: number;
  readonly expectedUrl: string;
}

export class RunnerWssApi {
  private agentId: string | null = null;
  private readonly threads = new Set<string>();
  private readonly runs = new Set<string>();
  private cleanupSignal: AbortSignal | undefined;
  lastHttpStatus: number | undefined;

  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
    private readonly signal: AbortSignal = new AbortController().signal,
  ) {}

  async request(
    path: string,
    method = "GET",
    body?: unknown,
    expected: readonly number[] = [200],
  ): Promise<unknown> {
    (this.cleanupSignal ?? this.signal).throwIfAborted();
    const response = await fetch(new URL(path, this.apiUrl), {
      method,
      headers: {
        ...authHeadersForToken(this.token),
        "Content-Type": "application/json",
        "X-Chat-Event-Schema-Version": String(
          CURRENT_CHAT_EVENT_SCHEMA_VERSION,
        ),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([
        this.cleanupSignal ?? this.signal,
        AbortSignal.timeout(15_000),
      ]),
      redirect: "error",
    });
    this.lastHttpStatus = response.status;
    if (!expected.includes(response.status)) {
      await response.body?.cancel();
      throw new Error(
        `Public WSS fixture operation returned HTTP ${response.status}`,
      );
    }
    if (response.status === 204) return null;
    return (await response.json()) as unknown;
  }

  async verifyMockProfile(model: string): Promise<void> {
    const switches = object(await this.request("/api/feature-switches"));
    expect(object(switches.effectiveSwitches)._realAgentInPreview).toBe(false);
    const models = object(await this.request("/api/run-models")).models;
    if (
      !Array.isArray(models) ||
      !models.some((value) => {
        const candidate = object(value);
        if (candidate.model !== model) return false;
        const effective = object(candidate.memberEffective);
        return (
          candidate.model === model &&
          effective.providerType === "codex-oauth-token" &&
          effective.credentialScope === "member"
        );
      })
    )
      throw new Error("Prepared mock Codex model unavailable");
  }

  async createAgent(): Promise<void> {
    const created = object(
      await this.request(
        "/api/agents",
        "POST",
        { displayName: `e2e-wss-${randomUUID()}`, visibility: "private" },
        [201],
      ),
    );
    this.agentId = id(created.agentId);
  }

  async start(model: string, seconds: number): Promise<OwnedWssRun> {
    if (!this.agentId) throw new Error("Owned agent unavailable");
    const clientEventId = randomUUID();
    const prompt = `@shell@\nset -eu\nsleep ${seconds}\nprintf WSS_WORK_FINISHED\n@end-shell@`;
    const sent = object(
      await this.request(
        "/api/chat/events",
        "POST",
        {
          agentId: this.agentId,
          prompt,
          clientEventId,
          userMessage: { version: 1, parts: [{ type: "text", text: prompt }] },
          hasTextContent: true,
          model,
        },
        [201],
      ),
    );
    const threadId = id(sent.threadId);
    this.threads.add(threadId);
    let runId: string | null = null;
    await expect
      .poll(
        async () => {
          const response = object(
            await this.request(
              `/api/chat-threads/${threadId}/event-rows?sinceSeqId=0&limit=50`,
            ),
          );
          if (!Array.isArray(response.rows))
            throw new Error("Public chat rows unavailable");
          for (const value of response.rows) {
            const row = object(value);
            if (row.revokesEventId !== clientEventId) continue;
            if (row.eventType === "input.rejected")
              throw new Error("Owned input rejected");
            if (row.eventType === "input.prompt" && row.runId) {
              runId = id(row.runId);
              this.runs.add(runId);
              return true;
            }
          }
          return false;
        },
        { timeout: 60_000, message: "Public input must launch an owned Run" },
      )
      .toBe(true);
    if (!runId) throw new Error("Owned Run unavailable");
    const launchedId: string = runId;
    await expect
      .poll(async () => await this.status(launchedId), {
        timeout: 30_000,
        message: "Owned Run must become running",
      })
      .toBe("running");
    const runner = object(await this.request(`/api/runs/${launchedId}/runner`));
    const runnerId = id(runner.runnerId);
    const hostname = runner.runnerHostname;
    const generation = runner.runnerHeartbeatGeneration;
    if (
      typeof hostname !== "string" ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(hostname) ||
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation <= 0
    )
      throw new Error("Official Run attribution unavailable");
    return {
      runId: launchedId,
      threadId,
      runnerId,
      hostname,
      heartbeatGeneration: generation,
      expectedUrl: `wss://${hostname}:443/ws/${runnerId}`,
    };
  }

  async status(runId: string): Promise<string> {
    const run = object(await this.request(`/api/runs/${id(runId)}`));
    if (typeof run.status !== "string")
      throw new Error("Public Run status unavailable");
    return run.status;
  }

  async waitForStatus(
    runId: string,
    status: "completed" | "cancelled",
  ): Promise<void> {
    await expect
      .poll(
        async () => {
          const value = await this.status(runId);
          if (TERMINAL.has(value) && value !== status)
            throw new Error("Owned Run reached unexpected terminal state");
          return value;
        },
        {
          timeout: 90_000,
          message: "Owned Run must reach its expected terminal state",
        },
      )
      .toBe(status);
  }

  async cancel(runId: string): Promise<void> {
    const response = object(
      await this.request(`/api/runs/${id(runId)}/cancel`, "POST"),
    );
    expect(response.status).toBe("cancelled");
  }

  async cleanup(): Promise<void> {
    this.cleanupSignal = AbortSignal.timeout(45_000);
    const failures: unknown[] = [];
    for (const runId of this.runs) {
      try {
        if (!TERMINAL.has(await this.status(runId))) {
          await this.request(
            `/api/runs/${runId}/cancel`,
            "POST",
            undefined,
            [200, 409],
          );
          await expect
            .poll(async () => TERMINAL.has(await this.status(runId)), {
              timeout: 30_000,
            })
            .toBe(true);
        }
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    for (const threadId of this.threads) {
      try {
        await this.request(
          `/api/chat-threads/${threadId}`,
          "DELETE",
          undefined,
          [204],
        );
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (this.agentId) {
      try {
        await this.request(
          `/api/agents/${this.agentId}`,
          "DELETE",
          undefined,
          [204],
        );
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Owned WSS cleanup failed");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid public fixture response");
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value))
    throw new Error("Invalid public fixture identity");
  return value;
}
