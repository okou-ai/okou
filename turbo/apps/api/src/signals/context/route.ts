import {
  type AppRoute,
  validateResponse,
} from "@okouai/api-contracts/contracts/trpc-contract";
import { createStore, type Command, type Computed } from "ccstate";
import type { Context, Handler } from "hono";
import type { ContentfulStatusCode, StatusCode } from "hono/utils/http-status";

import { monotonicNow, now } from "../../lib/time";
import { logger } from "../../lib/log";
import {
  setUsagePricingResolution$,
  type UsagePricingResolution,
} from "./usage-pricing-resolution";
import { initHono$ } from "./hono";
import { requestValidation$ } from "./request";
import { setRootSignal$ } from "./root";
import { safeSync } from "../utils";
import {
  setSystemSkillStorageResolution$,
  type SystemSkillStorageResolution,
} from "./system-skill-storage-resolution";

export type SignalRouteHandler<T> = Computed<T> | Command<T, [AbortSignal]>;

const L = logger("SignalRoute");

export interface JsonResponseObservation {
  readonly byteLength: number;
  readonly serializationDurationMs: number;
}

export type JsonResponseObserver = (
  context: Context,
  observation: JsonResponseObservation,
) => void;

interface HonoSignalHandlerOptions {
  readonly usagePricingResolution?: UsagePricingResolution;
  readonly systemSkillStorageResolution?: SystemSkillStorageResolution;
  readonly observeJsonResponse?: JsonResponseObserver;
}

interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

interface HeadersLike {
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

interface ResponseLike {
  readonly status: number;
  readonly statusText?: string;
  readonly headers: HeadersLike;
  readonly body: ConstructorParameters<typeof Response>[0];
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isHeadersLike(value: unknown): value is HeadersLike {
  return isRecord(value) && typeof value[Symbol.iterator] === "function";
}

function isResponseLike(value: unknown): value is ResponseLike {
  return (
    isRecord(value) &&
    typeof value.status === "number" &&
    isHeadersLike(value.headers) &&
    typeof value.arrayBuffer === "function" &&
    typeof value.blob === "function" &&
    typeof value.clone === "function" &&
    typeof value.formData === "function" &&
    typeof value.json === "function" &&
    typeof value.text === "function"
  );
}

function cloneHeaders(headers: HeadersLike): Headers {
  const cloned = new Headers();
  for (const [key, value] of headers) {
    cloned.append(key, value);
  }
  return cloned;
}

function toResponse(response: ResponseLike): Response {
  const init = {
    headers: cloneHeaders(response.headers),
    status: response.status,
  };
  if (typeof response.statusText === "string") {
    return new Response(response.body, {
      ...init,
      statusText: response.statusText,
    });
  }
  return new Response(response.body, init);
}

function isRouteResult(value: unknown): value is RouteResult {
  return (
    isRecord(value) &&
    "status" in value &&
    "body" in value &&
    typeof value.status === "number"
  );
}

function isCommand<T>(
  handler$: SignalRouteHandler<T>,
): handler$ is Command<T, [AbortSignal]> {
  return "write" in handler$;
}

function isContentlessStatus(status: StatusCode): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

export function honoSignalHandler(
  handler$: SignalRouteHandler<unknown>,
  contract: AppRoute,
  signal: AbortSignal,
  {
    usagePricingResolution,
    systemSkillStorageResolution,
    observeJsonResponse,
  }: HonoSignalHandlerOptions = {},
): Handler {
  return async (context) => {
    const apiStartTime = now();
    const store = createStore();
    store.set(setRootSignal$, signal);
    store.set(initHono$, context, contract, apiStartTime);
    if (usagePricingResolution) {
      store.set(setUsagePricingResolution$, usagePricingResolution);
    }
    if (systemSkillStorageResolution) {
      store.set(setSystemSkillStorageResolution$, systemSkillStorageResolution);
    }

    // Mirror the contract client order: path/query validation
    // precedes auth and downstream services, so a malformed request returns
    // 400 without touching either.
    const validationError = store.get(requestValidation$);
    if (validationError) {
      return context.json(validationError.body, validationError.status);
    }

    const data = await (isCommand(handler$)
      ? store.set(handler$, signal)
      : store.get(handler$));

    if (data instanceof Response) {
      return data;
    }

    if (isResponseLike(data)) {
      return toResponse(data);
    }

    if (!isRouteResult(data)) {
      throw new Error("Route handler must return a contract response object");
    }

    const response = validateResponse({
      appRoute: contract,
      response: data,
    });
    const status = response.status as StatusCode;
    if (
      isContentlessStatus(status) ||
      !("body" in response) ||
      response.body === undefined
    ) {
      return context.body(null, status);
    }

    if (!observeJsonResponse || status < 200 || status >= 300) {
      return context.json(response.body, status as ContentfulStatusCode);
    }

    const serializationStartedAt = monotonicNow();
    const serialized = JSON.stringify(response.body);
    if (serialized === undefined) {
      throw new Error("Validated JSON response could not be serialized");
    }
    const serializationDurationMs = Math.max(
      0,
      monotonicNow() - serializationStartedAt,
    );
    const jsonResponse = context.body(
      serialized,
      status as ContentfulStatusCode,
      {
        "Content-Type": "application/json",
      },
    );
    const observationResult = safeSync(() => {
      observeJsonResponse(context, {
        byteLength: Buffer.byteLength(serialized),
        serializationDurationMs,
      });
    });
    if ("error" in observationResult) {
      // An ordinary observation error must not fail a successful claim.
      L.warn("JSON response observation failed");
    }
    return jsonResponse;
  };
}
