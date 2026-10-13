import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "../../turbo/packages/api-contracts/src/contracts/chat-event-schema-version";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled", "timeout"]);

export interface OwnedWssRun {
  readonly runId: string;
  readonly runnerId: string;
  readonly hostname: string;
  readonly expectedUrl: string;
}

export interface WssTicket {
  readonly wssUrl: string;
  readonly ticket: string;
  readonly expiresAt: string;
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

  private async request(
    path: string,
    method = "GET",
    body?: unknown,
    expected: readonly number[] = [200],
    signal = this.cleanupSignal ?? this.signal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const response = await fetch(new URL(path, this.apiUrl), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
        "Content-Type": "application/json",
        "X-Chat-Event-Schema-Version": String(
          CURRENT_CHAT_EVENT_SCHEMA_VERSION,
        ),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      redirect: "error",
    });
    this.lastHttpStatus = response.status;
    if (!expected.includes(response.status)) {
      await response.body?.cancel();
      throw new Error(`Public WSS operation returned HTTP ${response.status}`);
    }
    if (response.status === 204) return null;
    return (await response.json()) as unknown;
  }

  async verifyMockProfile(model: string): Promise<void> {
    const switches = object(await this.request("/api/feature-switches"));
    assert.equal(object(switches.effectiveSwitches)._realAgentInPreview, false);
    const models = object(await this.request("/api/run-models")).models;
    if (
      !Array.isArray(models) ||
      !models.some((value) => {
        const candidate = object(value);
        if (candidate.model !== model) return false;
        const effective = object(candidate.memberEffective);
        return (
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
        {
          displayName: `e2e-wss-${randomUUID()}`,
          visibility: "private",
        },
        [201],
      ),
    );
    this.agentId = id(created.agentId);
  }

  async start(model: string): Promise<OwnedWssRun> {
    if (!this.agentId) throw new Error("Owned agent unavailable");
    const clientEventId = randomUUID();
    const ready = `WSS_READY_${clientEventId}`;
    const prompt = `@shell-checkpoint@\nprintf ${ready}\n@continue@\nset -eu\nsleep 300\nprintf WSS_WORK_FINISHED`;
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
    await this.poll(async (signal) => {
      const response = object(
        await this.request(
          `/api/chat-threads/${threadId}/event-rows?sinceSeqId=0&limit=50`,
          "GET",
          undefined,
          [200],
          signal,
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
    }, 60_000);
    if (!runId) throw new Error("Owned Run unavailable");
    const launchedId: string = runId;
    await this.poll(async (signal) => {
      const status = await this.status(launchedId, signal);
      if (TERMINAL.has(status))
        throw new Error("Owned Run ended before connection");
      return status === "running";
    }, 30_000);
    // Running attribution can precede local Guest preparation. Wait for the
    // owned Guest's public checkpoint before spending an admission ticket.
    await this.poll(async (signal) => {
      const response = object(
        await this.request(
          `/api/chat-threads/${threadId}/event-rows?sinceSeqId=0&limit=50`,
          "GET",
          undefined,
          [200],
          signal,
        ),
      );
      if (!Array.isArray(response.rows))
        throw new Error("Public chat rows unavailable");
      return response.rows.some((value) => {
        const row = object(value);
        if (row.runId !== launchedId || row.eventType !== "output.message")
          return false;
        const payload = object(row.payload);
        return (
          typeof payload.content === "string" && payload.content.includes(ready)
        );
      });
    }, 30_000);
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
      runnerId,
      hostname,
      expectedUrl: `wss://${hostname}:443/ws/${runnerId}`,
    };
  }

  async bootstrap(run: OwnedWssRun): Promise<WssTicket> {
    const body = object(
      await this.request(`/api/runs/${id(run.runId)}/wss/bootstrap`, "POST"),
    );
    if (
      body.wssUrl !== run.expectedUrl ||
      typeof body.ticket !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.ticket) ||
      typeof body.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(body.expiresAt))
    )
      throw new Error("Invalid WSS bootstrap response");
    return {
      wssUrl: run.expectedUrl,
      ticket: body.ticket,
      expiresAt: body.expiresAt,
    };
  }

  private async status(
    runId: string,
    signal = this.cleanupSignal ?? this.signal,
  ): Promise<string> {
    const run = object(
      await this.request(
        `/api/runs/${id(runId)}`,
        "GET",
        undefined,
        [200],
        signal,
      ),
    );
    if (typeof run.status !== "string")
      throw new Error("Public Run status unavailable");
    return run.status;
  }

  private async poll(
    read: (signal: AbortSignal) => Promise<boolean>,
    timeout: number,
  ): Promise<void> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeout);
    const signal = AbortSignal.any([
      this.cleanupSignal ?? this.signal,
      deadline.signal,
    ]);
    try {
      for (;;) {
        signal.throwIfAborted();
        const ready = await read(signal);
        signal.throwIfAborted();
        if (ready) return;
        await delay(300, undefined, { signal });
      }
    } finally {
      clearTimeout(timer);
    }
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
          await this.poll(
            async (signal) => TERMINAL.has(await this.status(runId, signal)),
            30_000,
          );
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
    throw new Error("Invalid public WSS response");
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value))
    throw new Error("Invalid public WSS identity");
  return value;
}
