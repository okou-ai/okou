import { command } from "ccstate";
import type {
  TestUsageStateActionBody,
  TestUsageStateActionResponse,
  TestUsageStateFixture,
} from "@okouai/api-contracts/contracts/test-usage-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testUsageStateRoutes } from "../../test-usage-state";

const USAGE_STATE_ROUTE = "/api/test/usage-state";

export interface UsageStateFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface ComposeResult {
  readonly composeId: string;
  readonly agentId: string;
}

interface SeedRunArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly triggerSource?: string;
  readonly chatThreadId?: string;
  readonly status?: string;
  readonly prompt?: string;
  readonly createdAt?: Date;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly continuedFromSessionId?: string | null;
  readonly sandboxReuseResult?: string | null;
  readonly workspaceReuseResult?: string | null;
  readonly result?: Record<string, unknown> | null;
  readonly error?: string | null;
  readonly lastEventSequence?: number | null;
  readonly selectedModel?: string | null;
  readonly lifecycleOnly?: boolean;
}

interface InsertUsageEventArgs {
  readonly orgId: string;
  readonly userId?: string;
  readonly runId?: string | null;
  readonly kind?: string;
  readonly provider?: string;
  readonly category?: string;
  readonly quantity?: number;
  readonly status?: string;
  readonly creditsCharged?: number;
  readonly idempotencyKey?: string;
  readonly billingError?: string | null;
  readonly createdAt?: Date;
  readonly processedAt?: Date | null;
  readonly count?: number;
}

interface UsageStorageCounts {
  readonly raw: number;
  readonly hourly: number;
}

interface UsageCompactionStorageCounts {
  readonly raw: number;
  readonly processedRaw: number;
  readonly hourly: number;
}

interface UsageEventState {
  readonly id: string;
  readonly status: string;
  readonly creditsCharged: number | null;
  readonly billingError: string | null;
}

interface UsageAllowanceWindowPair {
  readonly shortWindowId: string;
  readonly weeklyWindowId: string;
}

interface UsageAllowanceWindowState {
  readonly shortWindowConsumedUnits: string;
  readonly weeklyWindowConsumedUnits: string;
  readonly rawAllowanceUnits: string;
  readonly hourlyAllowanceUnits: string;
  readonly allocationCount: number;
}

function requestUsageState(
  signal: AbortSignal,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: testUsageStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

function dateToWire(value: Date | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return value.toISOString();
}

function fixtureFromWire(fixture: TestUsageStateFixture): UsageStateFixture {
  return {
    orgId: fixture.org_id,
    userId: fixture.user_id,
  };
}

function fixtureToWire(fixture: UsageStateFixture): TestUsageStateFixture {
  return {
    org_id: fixture.orgId,
    user_id: fixture.userId,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postAction(
  signal: AbortSignal,
  body: TestUsageStateActionBody,
): Promise<TestUsageStateActionResponse> {
  const response = await requestUsageState(
    signal,
    `${USAGE_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  signal.throwIfAborted();
  await expectOk(response, `usage state action ${body.action}`);
  signal.throwIfAborted();
  const result = await readJson<TestUsageStateActionResponse>(response);
  signal.throwIfAborted();
  return result;
}

export const seedUsageStateFixture$ = command(
  async (_, _input: void, signal: AbortSignal): Promise<UsageStateFixture> => {
    const response = await postAction(signal, { action: "seed-fixture" });
    if (!response.fixture) {
      throw new Error("seedUsageStateFixture$: response missing fixture");
    }
    return fixtureFromWire(response.fixture);
  },
);

export const deleteUsageStateFixture$ = command(
  async (_, fixture: UsageStateFixture, signal: AbortSignal): Promise<void> => {
    await postAction(signal, {
      action: "delete-fixture",
      fixture: fixtureToWire(fixture),
    });
  },
);

export const seedCompose$ = command(
  async (
    _,
    args: {
      orgId: string;
      userId: string;
      name?: string;
      displayName?: string | null;
      visibility?: "public" | "private";
    },
    signal: AbortSignal,
  ): Promise<ComposeResult> => {
    const response = await postAction(signal, {
      action: "seed-compose",
      org_id: args.orgId,
      user_id: args.userId,
      name: args.name,
      display_name: args.displayName,
      visibility: args.visibility,
    });
    if (!response.compose_id || !response.agent_id) {
      throw new Error("seedCompose$: response missing compose identifiers");
    }
    return {
      composeId: response.compose_id,
      agentId: response.agent_id,
    };
  },
);

export const seedRun$ = command(
  async (
    _,
    args: SeedRunArgs,
    signal: AbortSignal,
  ): Promise<{ runId: string }> => {
    const response = await postAction(signal, {
      action: "seed-run",
      org_id: args.orgId,
      user_id: args.userId,
      compose_id: args.composeId,
      trigger_source: args.triggerSource,
      chat_thread_id: args.chatThreadId,
      status: args.status,
      prompt: args.prompt,
      created_at: dateToWire(args.createdAt) ?? undefined,
      started_at: dateToWire(args.startedAt),
      completed_at: dateToWire(args.completedAt),
      continued_from_session_id: args.continuedFromSessionId,
      sandbox_reuse_result: args.sandboxReuseResult,
      workspace_reuse_result: args.workspaceReuseResult,
      result: args.result,
      error: args.error,
      last_event_sequence: args.lastEventSequence,
      selected_model: args.selectedModel,
      lifecycle_only: args.lifecycleOnly,
    });
    if (!response.run_id) {
      throw new Error("seedRun$: response missing run_id");
    }
    return { runId: response.run_id };
  },
);

export const seedChatThread$ = command(
  async (
    _,
    args: {
      readonly userId: string;
      readonly composeId: string;
      readonly title?: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const response = await postAction(signal, {
      action: "seed-chat-thread",
      user_id: args.userId,
      compose_id: args.composeId,
      title: args.title,
    });
    if (!response.chat_thread_id) {
      throw new Error("seedChatThread$: response missing chat_thread_id");
    }
    return response.chat_thread_id;
  },
);

export const insertUsageEvent$ = command(
  async (
    _,
    args: InsertUsageEventArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const response = await postAction(signal, {
      action: "insert-usage-event",
      org_id: args.orgId,
      user_id: args.userId,
      run_id: args.runId,
      kind: args.kind,
      provider: args.provider,
      category: args.category,
      quantity: args.quantity,
      status: args.status,
      credits_charged: args.creditsCharged,
      idempotency_key: args.idempotencyKey,
      billing_error: args.billingError,
      created_at: dateToWire(args.createdAt) ?? undefined,
      processed_at: dateToWire(args.processedAt),
      count: args.count,
    });
    if (!response.usage_event_id) {
      throw new Error("insertUsageEvent$: response missing usage_event_id");
    }
    return response.usage_event_id;
  },
);

export const attachUsageAllowance$ = command(
  async (
    _,
    args: {
      readonly orgId: string;
      readonly runId: string | null;
      readonly usageEventId: string;
      readonly unitsApplied: number;
      readonly consumedUnits: number;
    },
    signal: AbortSignal,
  ): Promise<UsageAllowanceWindowPair> => {
    const response = await postAction(signal, {
      action: "attach-usage-allowance",
      org_id: args.orgId,
      run_id: args.runId,
      usage_event_id: args.usageEventId,
      units_applied: args.unitsApplied,
      consumed_units: args.consumedUnits,
    });
    if (!response.short_window_id || !response.weekly_window_id) {
      throw new Error("attachUsageAllowance$: response missing window IDs");
    }
    return {
      shortWindowId: response.short_window_id,
      weeklyWindowId: response.weekly_window_id,
    };
  },
);

export const readAllowanceWindowState$ = command(
  async (
    _,
    pair: UsageAllowanceWindowPair,
    signal: AbortSignal,
  ): Promise<UsageAllowanceWindowState> => {
    const response = await postAction(signal, {
      action: "read-allowance-window-state",
      short_window_id: pair.shortWindowId,
      weekly_window_id: pair.weeklyWindowId,
    });
    if (
      response.short_window_consumed_units === undefined ||
      response.weekly_window_consumed_units === undefined ||
      response.raw_allowance_units === undefined ||
      response.hourly_allowance_units === undefined ||
      response.allocation_count === undefined
    ) {
      throw new Error(
        "readAllowanceWindowState$: response missing allowance state",
      );
    }
    return {
      shortWindowConsumedUnits: response.short_window_consumed_units,
      weeklyWindowConsumedUnits: response.weekly_window_consumed_units,
      rawAllowanceUnits: response.raw_allowance_units,
      hourlyAllowanceUnits: response.hourly_allowance_units,
      allocationCount: response.allocation_count,
    };
  },
);

export const readUsageEventState$ = command(
  async (
    _,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<UsageEventState> => {
    const response = await postAction(signal, {
      action: "read-usage-event-state",
      idempotency_key: idempotencyKey,
    });
    if (
      !response.usage_event_id ||
      !response.usage_event_status ||
      response.usage_event_credits_charged === undefined ||
      response.usage_event_billing_error === undefined
    ) {
      throw new Error("readUsageEventState$: response missing event state");
    }
    return {
      id: response.usage_event_id,
      status: response.usage_event_status,
      creditsCharged: response.usage_event_credits_charged,
      billingError: response.usage_event_billing_error,
    };
  },
);

export const deleteRun$ = command(
  async (_, runId: string, signal: AbortSignal): Promise<void> => {
    await postAction(signal, { action: "delete-run", run_id: runId });
  },
);

export const seedUsageOverflowGrain$ = command(
  async (
    _,
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly processedAt: Date;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "seed-usage-overflow-grain",
      org_id: args.orgId,
      user_id: args.userId,
      processed_at: args.processedAt.toISOString(),
    });
  },
);

export const materializeHourlyUsage$ = command(
  async (
    _,
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string | null;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    const response = await postAction(signal, {
      action: "materialize-hourly-usage",
      org_id: args.orgId,
      user_id: args.userId,
      run_id: args.runId,
    });
    if (response.hourly_count === undefined) {
      throw new Error("materializeHourlyUsage$: response missing hourly_count");
    }
    return response.hourly_count;
  },
);

export const readUsageStorageCounts$ = command(
  async (
    _,
    args: {
      readonly scope: "organization" | "user";
      readonly id: string;
    },
    signal: AbortSignal,
  ): Promise<UsageStorageCounts> => {
    const response = await postAction(signal, {
      action: "read-usage-storage-counts",
      scope: args.scope,
      id: args.id,
    });
    if (
      response.raw_count === undefined ||
      response.hourly_count === undefined
    ) {
      throw new Error(
        "readUsageStorageCounts$: response missing storage counts",
      );
    }
    return {
      raw: response.raw_count,
      hourly: response.hourly_count,
    };
  },
);

export const readUsageCompactionStorageCounts$ = command(
  async (
    _,
    args: {
      readonly scope: "organization" | "user";
      readonly id: string;
    },
    signal: AbortSignal,
  ): Promise<UsageCompactionStorageCounts> => {
    const response = await postAction(signal, {
      action: "read-usage-storage-counts",
      scope: args.scope,
      id: args.id,
    });
    if (
      response.raw_count === undefined ||
      response.processed_raw_count === undefined ||
      response.hourly_count === undefined
    ) {
      throw new Error(
        "readUsageCompactionStorageCounts$: response missing storage counts",
      );
    }
    return {
      raw: response.raw_count,
      processedRaw: response.processed_raw_count,
      hourly: response.hourly_count,
    };
  },
);

export const deleteUsageData$ = command(
  async (
    _,
    args: {
      readonly scope: "organization" | "user";
      readonly id: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "delete-usage-data",
      scope: args.scope,
      id: args.id,
    });
  },
);
