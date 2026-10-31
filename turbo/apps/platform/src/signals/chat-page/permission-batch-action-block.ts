import {
  userPermissionGrantBatchItemSchema,
  userPermissionGrantBatchItemsSchema,
} from "@okouai/api-contracts/validators/user-permission-grants";
import type {
  UserPermissionGrantBatchItem,
  UserPermissionGrantExpiresIn,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { parseUserPermissionGrantExpiresIn } from "../permission-allow/permission-grant-expiration.ts";
import {
  chatActionCallbackFromUrl,
  type ChatActionCallback,
} from "./action-callback.ts";
import {
  chatActionIdMatches,
  type ChatActionContext,
  type ChatActionParseResult,
} from "./chat-action-context.ts";
import { parseTrustedPlatformUrl } from "./trusted-platform-url.ts";
import { jsonParseOr } from "../utils.ts";

export interface PermissionBatchActionDescriptor extends ChatActionCallback {
  readonly scope: "agent";
  readonly agentId: string;
  readonly items: UserPermissionGrantBatchItem[];
  readonly expiresIn: UserPermissionGrantExpiresIn | null;
  readonly originalUrl: string;
  readonly href: string;
}

export function permissionBatchActionResourceKey(
  descriptor: Omit<PermissionBatchActionDescriptor, "href">,
): string {
  const params = new URLSearchParams({
    items: JSON.stringify(descriptor.items),
    action: "allow",
  });
  if (descriptor.expiresIn !== null) {
    params.set("expiresIn", descriptor.expiresIn);
  }
  if (descriptor.threadId !== null && descriptor.callbackPrompt !== null) {
    params.set("threadId", descriptor.threadId);
    params.set("callbackPrompt", descriptor.callbackPrompt);
  }
  return `/agents/${encodeURIComponent(descriptor.agentId)}/permissions/batch?${params.toString()}`;
}

function parseItems(
  value: string | null,
): UserPermissionGrantBatchItem[] | null {
  if (value === null) {
    return null;
  }
  const rows: unknown = jsonParseOr<unknown>(value, null);
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 20) {
    return null;
  }
  const unique = new Map<string, UserPermissionGrantBatchItem>();
  // Validate every original row before deduplication: a malformed duplicate
  // must invalidate the whole action rather than disappear during normalization.
  for (const row of rows) {
    const parsed = userPermissionGrantBatchItemSchema.safeParse(row);
    if (!parsed.success) {
      return null;
    }
    unique.set(
      JSON.stringify([parsed.data.connectorSlug, parsed.data.permission]),
      parsed.data,
    );
  }
  const items = [...unique.values()].sort((left, right) => {
    if (left.connectorSlug !== right.connectorSlug) {
      return left.connectorSlug < right.connectorSlug ? -1 : 1;
    }
    return left.permission === right.permission
      ? 0
      : left.permission < right.permission
        ? -1
        : 1;
  });
  const parsed = userPermissionGrantBatchItemsSchema.safeParse(items);
  return parsed.success ? parsed.data : null;
}

function hasValidPercentEncoding(value: string): boolean {
  if (/%(?![\da-f]{2})/iu.test(value)) {
    return false;
  }
  // URLSearchParams silently replaces malformed UTF-8. Round-trip each run
  // of escaped bytes to reject that lossy normalization without throwing.
  for (const match of value.matchAll(/(?:%[\da-f]{2})+/giu)) {
    const bytes = Uint8Array.from(match[0].slice(1).split("%"), (byte) => {
      return Number.parseInt(byte, 16);
    });
    const encoded = new TextEncoder().encode(
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
    );
    if (
      encoded.length !== bytes.length ||
      encoded.some((byte, index) => {
        return byte !== bytes[index];
      })
    ) {
      return false;
    }
  }
  return true;
}

function hasValidBatchUrlStructure(value: string, url: URL): boolean {
  return !(
    new TextEncoder().encode(value).byteLength > 8192 ||
    new TextEncoder().encode(url.href).byteLength > 8192 ||
    !hasValidPercentEncoding(value) ||
    value.trim() !== value ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    }) ||
    url.hash ||
    url.username ||
    url.password
  );
}

export function parsePermissionBatchActionUrl(
  value: string,
  context: ChatActionContext | undefined,
): ChatActionParseResult<PermissionBatchActionDescriptor> {
  const url = parseTrustedPlatformUrl(value);
  const match = url?.pathname.match(/^\/agents\/([^/]+)\/permissions\/batch$/u);
  if (!url || !match) {
    return { status: "unrelated" };
  }
  const invalid = { status: "invalid", originalUrl: value } as const;
  if (!hasValidBatchUrlStructure(value, url)) {
    return invalid;
  }
  const allowed = new Set([
    "items",
    "action",
    "expiresIn",
    "threadId",
    "callbackPrompt",
  ]);
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || seen.has(key)) {
      return invalid;
    }
    seen.add(key);
  }
  if (
    !context ||
    !match[1] ||
    !chatActionIdMatches(match[1], context.agentId)
  ) {
    return invalid;
  }
  const action = url.searchParams.get("action");
  if (action !== "allow") {
    return invalid;
  }
  const expiresInValue = url.searchParams.get("expiresIn");
  const expiresIn = parseUserPermissionGrantExpiresIn(expiresInValue);
  if (expiresInValue !== null && expiresIn === null) {
    return invalid;
  }
  const items = parseItems(url.searchParams.get("items"));
  const callback = chatActionCallbackFromUrl(url, context);
  if (!items || !callback) {
    return invalid;
  }
  const descriptor = {
    scope: "agent",
    agentId: context.agentId,
    items,
    expiresIn,
    originalUrl: value,
    ...callback,
  } as const;
  return {
    status: "valid",
    descriptor: {
      ...descriptor,
      href: permissionBatchActionResourceKey(descriptor),
    },
  };
}
