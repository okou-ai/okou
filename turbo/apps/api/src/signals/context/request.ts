import { BROWSER_USER_ACTION_MAX_APPLY_BODY_BYTES } from "@okouai/api-contracts/contracts/browser-user-actions";
import type {
  AppRoute,
  SchemaOutput,
} from "@okouai/api-contracts/contracts/trpc-contract";
import { computed, type Computed } from "ccstate";

import { badRequest, badRequestMessage } from "../../lib/error";
import { rawPathParams$, rawQuery$, request$, route$ } from "./hono";
import { safeJsonParse } from "../utils";

interface ZodLikeIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

interface ZodLikeResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly issues: readonly ZodLikeIssue[] };
}

interface ZodLikeSchema {
  readonly safeParse: (input: unknown) => ZodLikeResult;
}

function isZodLikeSchema(value: unknown): value is ZodLikeSchema {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof (value as { safeParse: unknown }).safeParse === "function"
  );
}

const FALLBACK_ISSUE: ZodLikeIssue = Object.freeze({
  path: [],
  message: "Bad request",
});

type ValidationResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly issue: ZodLikeIssue };

const pathParamsResult$ = computed((get): ValidationResult => {
  const schema = get(route$).pathParams;
  if (!isZodLikeSchema(schema)) {
    return { ok: true, data: {} };
  }
  const result = schema.safeParse(get(rawPathParams$));
  if (!result.success) {
    return { ok: false, issue: result.error?.issues[0] ?? FALLBACK_ISSUE };
  }
  return { ok: true, data: result.data };
});

const queryResult$ = computed((get): ValidationResult => {
  const schema = get(route$).query;
  if (!isZodLikeSchema(schema)) {
    return { ok: true, data: {} };
  }
  const result = schema.safeParse(get(rawQuery$));
  if (!result.success) {
    return { ok: false, issue: result.error?.issues[0] ?? FALLBACK_ISSUE };
  }
  return { ok: true, data: result.data };
});

interface BadRequestResponse {
  readonly status: 400;
  readonly body: {
    readonly error: { readonly message: string; readonly code: string };
  };
}

export const requestValidation$: Computed<BadRequestResponse | null> = computed(
  (get): BadRequestResponse | null => {
    const path = get(pathParamsResult$);
    if (!path.ok) {
      return badRequest(path.issue);
    }
    const query = get(queryResult$);
    if (!query.ok) {
      return badRequest(query.issue);
    }
    return null;
  },
);

const validatedPathParams$ = computed((get): unknown => {
  const result = get(pathParamsResult$);
  if (!result.ok) {
    throw new Error("pathParamsOf accessed but path validation failed");
  }
  return result.data;
});

const validatedQuery$ = computed((get): unknown => {
  const result = get(queryResult$);
  if (!result.ok) {
    throw new Error("queryOf accessed but query validation failed");
  }
  return result.data;
});

type RouteWithPathParams = AppRoute & { readonly pathParams: unknown };
type RouteWithQuery = AppRoute & { readonly query: unknown };
type RouteWithBody = AppRoute & { readonly body: unknown };

// Reuse the contract-level shallow extractor so request helpers do not rematch
// against `z.ZodType<infer T>` and reopen Zod v4 variance checks.
type InferPathParams<R> = R extends { readonly pathParams: infer S }
  ? SchemaOutput<S>
  : never;
type InferQuery<R> = R extends { readonly query: infer S }
  ? SchemaOutput<S>
  : never;
type InferBody<R> = R extends { readonly body: infer S }
  ? SchemaOutput<S>
  : never;

type BodyResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly response: BadRequestResponse };

export function pathParamsOf<R extends RouteWithPathParams>(
  _route: R,
): Computed<InferPathParams<R>> {
  return validatedPathParams$ as Computed<InferPathParams<R>>;
}

export function queryOf<R extends RouteWithQuery>(
  _route: R,
): Computed<InferQuery<R>> {
  return validatedQuery$ as Computed<InferQuery<R>>;
}

async function boundedBrowserApplyBody(request: {
  readonly raw: Request;
}): Promise<string | null> {
  const limit = BROWSER_USER_ACTION_MAX_APPLY_BODY_BYTES;
  const declared = Number(request.raw.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    return null;
  }
  const stream = request.raw.body;
  if (!stream) {
    return "";
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  const read = async (): Promise<string | null> => {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  };
  return await read().finally(() => {
    reader.releaseLock();
  });
}

const bodyResult$ = computed(async (get): Promise<BodyResult<unknown>> => {
  const route = get(route$);
  const text =
    route.path === "/api/browser/user-actions/:requestToken/apply"
      ? await boundedBrowserApplyBody(get(request$))
      : await get(request$).text();
  if (text === null) {
    return {
      ok: false,
      response: badRequestMessage("Browser input request is too large"),
    };
  }

  const parsed = text.length === 0 ? {} : safeJsonParse(text);
  if (parsed === undefined) {
    return {
      ok: false,
      response: badRequestMessage("Invalid JSON in request body"),
    };
  }

  const schema = "body" in route ? route.body : undefined;
  if (!isZodLikeSchema(schema)) {
    return { ok: true, data: parsed };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      response: badRequest(result.error?.issues[0] ?? FALLBACK_ISSUE),
    };
  }

  return { ok: true, data: result.data };
});

export function bodyResultOf<R extends RouteWithBody>(
  _route: R,
): Computed<Promise<BodyResult<InferBody<R>>>> {
  return bodyResult$ as Computed<Promise<BodyResult<InferBody<R>>>>;
}
