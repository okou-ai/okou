import { z } from "zod";

import { env } from "../../lib/env";
import { readBoundedResponseText, safeJsonParse, settle } from "../utils";
import {
  commerceProviderResponseSchema,
  commerceProviderStatusSchema,
} from "./commerce.service";

const BASE_URL = "https://api.dataforseo.com/v3/merchant/amazon";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const submissionSchema = z.object({
  status_code: z.number().int(),
  cost: z.number().finite().nonnegative(),
  tasks: z
    .array(
      z.object({
        id: z.string().min(1).nullable(),
        status_code: z.number().int(),
      }),
    )
    .length(1),
});

export function commerceJobProviderConfigured(): boolean {
  return Boolean(
    env("OKOU_SEO_DATAFORSEO_LOGIN") && env("OKOU_SEO_DATAFORSEO_PASSWORD"),
  );
}

async function requestProvider(
  path: string,
  signal: AbortSignal,
  task?: Record<string, unknown>,
): Promise<unknown> {
  const login = env("OKOU_SEO_DATAFORSEO_LOGIN");
  const password = env("OKOU_SEO_DATAFORSEO_PASSWORD");
  if (!login || !password) {
    throw new Error("Commerce DataForSEO provider is not configured");
  }
  const response = await fetch(`${BASE_URL}/${path}`, {
    method: task ? "POST" : "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    ...(task ? { body: JSON.stringify([task]) } : {}),
    redirect: "error",
    signal,
  });
  const text = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
  if (!response.ok || text.kind === "too_large") {
    throw new Error("DataForSEO commerce request failed");
  }
  return safeJsonParse(text.text);
}

export async function submitCommerceTask(
  operation: "search" | "inspect",
  task: Record<string, unknown>,
  signal: AbortSignal,
) {
  // task_post is paid and has no provider idempotency key. An uncertain outcome
  // must never be retried automatically, including after a process restart.
  const outcome = await settle(
    requestProvider(
      `${operation === "search" ? "products" : "asin"}/task_post`,
      signal,
      task,
    ),
  );
  signal.throwIfAborted();
  if (!outcome.ok) {
    return { kind: "uncertain" } as const;
  }
  const parsed = submissionSchema.safeParse(outcome.value);
  if (!parsed.success) {
    return { kind: "uncertain" } as const;
  }
  const submitted = parsed.data.tasks[0];
  if (
    parsed.data.status_code !== 20_000 ||
    !submitted ||
    submitted.status_code !== 20_100
  ) {
    return { kind: "rejected" } as const;
  }
  if (
    !submitted.id ||
    !Number.isSafeInteger(Math.ceil(parsed.data.cost * 1_000_000))
  ) {
    return { kind: "uncertain" } as const;
  }
  return {
    kind: "submitted",
    id: submitted.id,
    cost: parsed.data.cost,
  } as const;
}

export async function readCommerceTask(
  operation: "search" | "inspect",
  providerTaskId: string,
  signal: AbortSignal,
) {
  // Exactly one read, not a wait loop. Transport/provider outages leave the
  // durable task available for the next client refresh or recovery sweep.
  const outcome = await settle(
    requestProvider(
      `${operation === "search" ? "products" : "asin"}/task_get/advanced/${encodeURIComponent(providerTaskId)}`,
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!outcome.ok) {
    return { kind: "pending" } as const;
  }
  const status = commerceProviderStatusSchema.safeParse(outcome.value);
  if (!status.success || status.data.status_code !== 20_000) {
    return { kind: "pending" } as const;
  }
  const task = status.data.tasks[0];
  if (!task || task.id !== providerTaskId) {
    return { kind: "pending" } as const;
  }
  if ([20_100, 40_601, 40_602].includes(task.status_code)) {
    return { kind: "pending" } as const;
  }
  // Terminal responses can contain items: null; their status does not depend on
  // satisfying the product payload contract used for successful tasks.
  if (task.status_code !== 20_000) {
    if (operation === "search" && task.status_code === 40_102) {
      return { kind: "empty", body: status.data } as const;
    }
    return { kind: "failed", body: status.data } as const;
  }
  const parsed = commerceProviderResponseSchema.safeParse(outcome.value);
  if (!parsed.success || !parsed.data.tasks[0]?.result) {
    return { kind: "pending" } as const;
  }
  return { kind: "completed", body: parsed.data } as const;
}
