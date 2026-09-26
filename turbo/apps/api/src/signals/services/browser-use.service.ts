import { createHash } from "node:crypto";
import { once } from "node:events";

import {
  BROWSER_INITIAL_SCREEN_HEIGHT,
  BROWSER_SCREEN_WIDTH,
} from "@okouai/api-contracts/contracts/browser";
import {
  BROWSER_USER_ACTION_MAX_ACCEPT_LENGTH,
  BROWSER_USER_ACTION_MAX_FILES,
  BROWSER_USER_ACTION_MAX_FILE_NAME_LENGTH,
  BROWSER_USER_ACTION_MAX_FILE_TYPE_LENGTH,
  BROWSER_USER_ACTION_MAX_OBSERVED_FILE_BYTES,
  BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH,
  BROWSER_USER_ACTION_MAX_OPTIONS,
  BROWSER_USER_ACTION_MAX_RADIO_MEMBERS,
  BROWSER_USER_ACTION_MAX_OPTION_LABEL_LENGTH,
  BROWSER_USER_ACTION_MAX_OPTION_VALUE_LENGTH,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { z } from "zod";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import {
  readBoundedResponseText,
  safeJsonParse,
  safeSync,
  settle,
  settleIncludingAbort,
} from "../utils";

const BROWSER_USE_API_BASE_URL = "https://api.browser-use.com/api/v3";
const BROWSER_USE_REQUEST_TIMEOUT_MS = 30_000;
const BROWSER_USE_CDP_REQUEST_TIMEOUT_MS = 15_000;
const L = logger("BrowserUseCDP");
const MAX_BROWSER_USE_RESPONSE_BYTES = 512 * 1024;
const MAX_BROWSER_USE_CDP_RESPONSE_BYTES = 64 * 1024;
const MAX_BROWSER_USE_SCREENSHOT_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BROWSER_USE_ERROR_MESSAGE_CHARS = 2048;
const MAX_BROWSER_USE_TAB_URLS = 50;
const MAX_BROWSER_USE_TAB_URL_CHARS = 8192;
const BROWSER_USE_SCREENSHOT_WIDTH = 640;
const BROWSER_USE_SCREENSHOT_QUALITY = 80;
const browserUseLiveUrlSchema = z.url().refine((value) => {
  return new URL(value).origin === "https://live.browser-use.com";
});

function isBrowserUseHostname(hostname: string): boolean {
  return (
    hostname === "browser-use.com" || hostname.endsWith(".browser-use.com")
  );
}

const browserUseCdpUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && isBrowserUseHostname(url.hostname);
});
const browserUseCdpWebSocketUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "wss:" && isBrowserUseHostname(url.hostname);
});
const browserUseCdpVersionSchema = z.object({
  webSocketDebuggerUrl: z.string().min(1),
});
const browserUseCdpResponseSchema = z.object({
  id: z.number().int(),
  result: z.unknown().optional(),
  error: z
    .object({
      message: z.string(),
    })
    .optional(),
});
const browserUseCdpTargetsSchema = z.object({
  targetInfos: z.array(
    z.object({
      targetId: z.string().min(1),
      type: z.string(),
      url: z.string(),
    }),
  ),
});
const browserUseCdpWindowSchema = z.object({
  windowId: z.number().int().nonnegative(),
});
const browserUseCdpAttachedTargetSchema = z.object({
  sessionId: z.string().min(1),
});
const browserUseCdpFocusSchema = z.object({
  result: z.object({
    value: z.boolean().optional(),
  }),
});
const browserUseCdpFrameTreeSchema = z.object({
  frameTree: z.object({
    frame: z.object({
      id: z.string().min(1),
      loaderId: z.string().min(1),
      url: z.string(),
    }),
  }),
});
const browserUseCdpRemoteObjectSchema = z.object({
  object: z.object({ objectId: z.string().min(1) }),
});
const browserUseCdpValueSchema = z.object({
  result: z.object({ value: z.unknown().optional() }),
});
const browserUseCdpLayoutMetricsSchema = z.object({
  cssVisualViewport: z.object({
    pageX: z.number().finite(),
    pageY: z.number().finite(),
    clientWidth: z.number().positive().finite(),
    clientHeight: z.number().positive().finite(),
  }),
});
const browserUseCdpScreenshotSchema = z.object({
  data: z.string().min(1),
});
type BrowserUseCdpSocketEventName = "open" | "message" | "error" | "close";
interface BrowserUseCdpSocketEvent {
  readonly name: BrowserUseCdpSocketEventName;
  readonly event: unknown;
}

interface BrowserUseCdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
  readonly maxResponseBytes?: number;
}

class BrowserUseCdpCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUseCdpCommandError";
  }
}

const browserUseProfileSchema = z.object({
  id: z.uuid(),
  userId: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const browserUseSessionSchema = z.object({
  id: z.uuid(),
  status: z.enum(["active", "stopped"]),
  timeoutAt: z.iso.datetime(),
  startedAt: z.iso.datetime(),
  liveUrl: browserUseLiveUrlSchema.nullish().transform((value) => {
    return value ?? null;
  }),
  cdpUrl: browserUseCdpUrlSchema.nullish().transform((value) => {
    return value ?? null;
  }),
  finishedAt: z.iso
    .datetime()
    .nullish()
    .transform((value) => {
      return value ?? null;
    }),
});

export type BrowserUseSession = z.infer<typeof browserUseSessionSchema>;

function parseBrowserUseSession(body: unknown): BrowserUseSession {
  return browserUseSessionSchema.parse(body, { reportInput: true });
}

export class BrowserUseProviderError extends Error {
  readonly status: 502 | 503;
  readonly code: string;

  constructor(status: 502 | 503, code: string, message: string) {
    super(message);
    this.name = "BrowserUseProviderError";
    this.status = status;
    this.code = code;
  }
}

export interface BrowserUseUserActionFingerprint {
  readonly tagName: "INPUT" | "TEXTAREA" | "SELECT";
  readonly inputType: string;
}

export interface BrowserUseUserActionTarget {
  readonly backendNodeId: number;
  readonly fingerprint: BrowserUseUserActionFingerprint;
  readonly radioMemberNodeIds?: readonly number[];
}

export interface BrowserUseUserActionValidation {
  readonly pageTargetId: string;
  readonly documentLoaderId: string;
  readonly pageUrl: string;
  readonly siteOrigin: string;
  readonly fields: readonly BrowserUseUserActionTarget[];
}

export type BrowserUseUserActionValidationFailureCode =
  | "page_target_not_found"
  | "unsupported_page"
  | "backend_node_not_found"
  | "unsupported_control";

export class BrowserUseUserActionValidationError extends Error {
  readonly code: BrowserUseUserActionValidationFailureCode;
  readonly fieldPosition?: number;

  constructor(
    code: BrowserUseUserActionValidationFailureCode,
    fieldPosition?: number,
  ) {
    super(`Browser user-action validation failed: ${code}`);
    this.name = "BrowserUseUserActionValidationError";
    this.code = code;
    this.fieldPosition = fieldPosition;
  }
}

export class BrowserUseUserActionMutationError extends Error {
  readonly writeStarted: boolean;

  constructor(writeStarted: boolean) {
    super("Browser user-action mutation failed");
    this.name = "BrowserUseUserActionMutationError";
    this.writeStarted = writeStarted;
  }
}

function browserUseCdpVersionUrl(cdpUrl: string): URL {
  const url = new URL(browserUseCdpUrlSchema.parse(cdpUrl));
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/json/version`;
  return url;
}

async function browserUseCdpWebSocketUrl(
  cdpUrl: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(browserUseCdpVersionUrl(cdpUrl), { signal });
  const text = await readBoundedResponseText(
    response,
    MAX_BROWSER_USE_CDP_RESPONSE_BYTES,
  );
  if (!response.ok || text.kind === "too_large") {
    throw new Error("Browser Use CDP discovery failed");
  }
  const version = browserUseCdpVersionSchema.parse(safeJsonParse(text.text), {
    reportInput: true,
  });
  return browserUseCdpWebSocketUrlSchema.parse(version.webSocketDebuggerUrl);
}

async function waitForBrowserUseCdpSocketEvent(
  socket: WebSocket,
  name: BrowserUseCdpSocketEventName,
  signal: AbortSignal,
): Promise<BrowserUseCdpSocketEvent> {
  const events: unknown[] = await once(socket, name, { signal });
  signal.throwIfAborted();
  return { name, event: events[0] };
}

async function nextBrowserUseCdpSocketEvent(
  socket: WebSocket,
  names: readonly BrowserUseCdpSocketEventName[],
  signal: AbortSignal,
): Promise<BrowserUseCdpSocketEvent> {
  const controller = new AbortController();
  const result = await settle(
    Promise.race(
      names.map(async (name) => {
        return await waitForBrowserUseCdpSocketEvent(
          socket,
          name,
          AbortSignal.any([signal, controller.signal]),
        );
      }),
    ),
  );
  controller.abort();
  signal.throwIfAborted();
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function waitForBrowserUseCdpSocket(
  socket: WebSocket,
  signal: AbortSignal,
): Promise<void> {
  const received = await nextBrowserUseCdpSocketEvent(
    socket,
    ["open", "error", "close"],
    signal,
  );
  if (received.name !== "open") {
    throw new Error("Browser Use CDP connection failed");
  }
}

async function sendBrowserUseCdpCommand(
  socket: WebSocket,
  command: BrowserUseCdpCommand,
  signal: AbortSignal,
): Promise<unknown> {
  const { id, method, params, sessionId, maxResponseBytes } = command;
  signal.throwIfAborted();
  // Keep one listener for the entire command: a nonmatching CDP event and its
  // reply can arrive back-to-back before an awaited one-shot listener re-arms.
  const { promise, resolve, reject } = (
    Promise as PromiseConstructor & {
      withResolvers<T>(): {
        promise: Promise<T>;
        resolve: (value: T) => void;
        reject: (reason?: unknown) => void;
      };
    }
  ).withResolvers<unknown>();
  let settled = false;
  function finish(complete: () => void): void {
    if (settled) {
      return;
    }
    settled = true;
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onDisconnect);
    socket.removeEventListener("close", onDisconnect);
    signal.removeEventListener("abort", onAbort);
    complete();
  }
  function onDisconnect(): void {
    finish(() => {
      reject(new Error("Browser Use CDP connection closed"));
    });
  }
  function onAbort(): void {
    finish(() => {
      reject(signal.reason);
    });
  }
  function onMessage(event: MessageEvent): void {
    if (
      settled ||
      typeof event.data !== "string" ||
      event.data.length >
        (maxResponseBytes ?? MAX_BROWSER_USE_CDP_RESPONSE_BYTES)
    ) {
      return;
    }
    const response = browserUseCdpResponseSchema.safeParse(
      safeJsonParse(event.data),
    );
    if (!response.success || response.data.id !== id) {
      return;
    }
    const error = response.data.error;
    if (error) {
      finish(() => {
        reject(new BrowserUseCdpCommandError(error.message));
      });
      return;
    }
    finish(() => {
      resolve(response.data.result);
    });
  }
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onDisconnect);
  socket.addEventListener("close", onDisconnect);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  } else if (!settled) {
    const sent = safeSync(() => {
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
    if ("error" in sent) {
      finish(() => {
        reject(sent.error);
      });
    }
  }
  // An abort can follow the matching message in the same event turn, before
  // this command resumes. Preserve cancellation precedence after settlement.
  const result = await settleIncludingAbort(promise);
  signal.throwIfAborted();
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function withBrowserUseCdpSocket<T>(
  cdpUrl: string,
  signal: AbortSignal,
  operation: (socket: WebSocket) => Promise<T>,
  observePhase?: BrowserUseCdpPhaseObserver,
): Promise<T> {
  const websocketUrl = await observeBrowserUseCdpPhase(
    "discovery",
    signal,
    observePhase,
    async () => {
      return await browserUseCdpWebSocketUrl(cdpUrl, signal);
    },
  );
  const socket = new WebSocket(websocketUrl);
  // Cancellation is rethrown only after the socket cleanup below has run.
  const result = await settleIncludingAbort(
    (async () => {
      await observeBrowserUseCdpPhase(
        "connection",
        signal,
        observePhase,
        async () => {
          return await waitForBrowserUseCdpSocket(socket, signal);
        },
      );
      return await operation(socket);
    })(),
  );
  if (
    socket.readyState === WebSocket.CONNECTING ||
    socket.readyState === WebSocket.OPEN
  ) {
    safeSync(() => {
      socket.close(1000);
    });
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function resizeBrowserUseCdp(
  cdpUrl: string,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<void> {
  await withBrowserUseCdpSocket(cdpUrl, signal, async (socket) => {
    const targets = browserUseCdpTargetsSchema.parse(
      await sendBrowserUseCdpCommand(
        socket,
        { id: 1, method: "Target.getTargets", params: {} },
        signal,
      ),
      { reportInput: true },
    );
    const target = targets.targetInfos.find((candidate) => {
      return candidate.type === "page";
    });
    if (!target) {
      throw new Error("Browser Use CDP returned no page target");
    }
    const window = browserUseCdpWindowSchema.parse(
      await sendBrowserUseCdpCommand(
        socket,
        {
          id: 2,
          method: "Browser.getWindowForTarget",
          params: { targetId: target.targetId },
        },
        signal,
      ),
      { reportInput: true },
    );
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: window.windowId, width, height },
      },
      signal,
    );
  });
}

function restorableBrowserUseTabUrl(url: string): boolean {
  if (url.length > MAX_BROWSER_USE_TAB_URL_CHARS || !URL.canParse(url)) {
    return false;
  }
  const protocol = new URL(url).protocol;
  return protocol === "http:" || protocol === "https:";
}

function boundedRestorableBrowserUseTabUrls(
  urls: Iterable<string>,
): readonly string[] {
  const boundedUrls: string[] = [];
  const seenUrls = new Set<string>();
  for (const url of urls) {
    if (!restorableBrowserUseTabUrl(url) || seenUrls.has(url)) {
      continue;
    }
    seenUrls.add(url);
    boundedUrls.push(url);
    if (boundedUrls.length === MAX_BROWSER_USE_TAB_URLS) {
      break;
    }
  }
  return boundedUrls;
}

function browserUseCdpSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([
    signal,
    AbortSignal.timeout(BROWSER_USE_CDP_REQUEST_TIMEOUT_MS),
  ]);
}

type BrowserUseCdpPhase =
  | "discovery"
  | "connection"
  | "target"
  | "targets"
  | "attach"
  | "frame"
  | "controls"
  | "validation";
type BrowserUseCdpPhaseOutcome = "ok" | "timeout" | "cancelled" | "error";
type BrowserUseCdpPhaseObserver = (
  phase: BrowserUseCdpPhase,
  outcome: BrowserUseCdpPhaseOutcome,
  durationMs: number,
  attachReplyObserved?: boolean,
) => void;

async function observeBrowserUseCdpPhase<T>(
  phase: BrowserUseCdpPhase,
  signal: AbortSignal,
  observe: BrowserUseCdpPhaseObserver | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!observe) {
    return await operation();
  }
  const startedAt = performance.now();
  const result = await settleIncludingAbort(operation());
  const outcome = result.ok
    ? "ok"
    : signal.aborted
      ? signal.reason instanceof Error && signal.reason.name === "TimeoutError"
        ? "timeout"
        : "cancelled"
      : "error";
  observe(phase, outcome, Math.round(performance.now() - startedAt));
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function nativeInputCdpPhaseObserver(
  operation: "create" | "preflight" | "apply",
  attemptId: string,
): BrowserUseCdpPhaseObserver {
  return (phase, outcome, durationMs, attachReplyObserved) => {
    const fields = {
      type:
        operation === "create"
          ? "browser_input_create_phase"
          : operation === "preflight"
            ? "browser_input_preflight_phase"
            : "browser_input_apply_phase",
      attemptId,
      operation,
      phase,
      outcome,
      durationMs,
      ...(phase === "attach" && attachReplyObserved !== undefined
        ? { attachReplyObserved }
        : {}),
    };
    const message =
      operation === "create"
        ? "Browser input create CDP phase"
        : operation === "preflight"
          ? "Browser input preflight CDP phase"
          : "Browser input apply CDP phase";
    if (outcome === "ok" && durationMs < 1000) {
      L.debug(message, fields);
    } else {
      L.warn(message, fields);
    }
  };
}

async function withBrowserUseCdpDeadline<T>(
  signal: AbortSignal,
  operation: (cdpSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(BROWSER_USE_CDP_REQUEST_TIMEOUT_MS);
  const result = await settleIncludingAbort(
    operation(AbortSignal.any([signal, timeoutSignal])),
  );
  signal.throwIfAborted();
  if (timeoutSignal.aborted) {
    throw new BrowserUseProviderError(
      503,
      "BROWSER_USE_TIMEOUT",
      "Managed browser check timed out",
    );
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

export async function listBrowserUseTabUrls(
  cdpUrl: string,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const cdpSignal = browserUseCdpSignal(signal);
  return await withBrowserUseCdpSocket(cdpUrl, cdpSignal, async (socket) => {
    const targets = browserUseCdpTargetsSchema.parse(
      await sendBrowserUseCdpCommand(
        socket,
        { id: 1, method: "Target.getTargets", params: {} },
        cdpSignal,
      ),
      { reportInput: true },
    );
    return boundedRestorableBrowserUseTabUrls(
      targets.targetInfos
        .filter((target) => {
          return target.type === "page";
        })
        .map((target) => {
          return target.url;
        }),
    );
  });
}

export async function captureBrowserUseScreenshot(
  cdpUrl: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const cdpSignal = browserUseCdpSignal(signal);
  return await withBrowserUseCdpSocket(cdpUrl, cdpSignal, async (socket) => {
    const targets = browserUseCdpTargetsSchema.parse(
      await sendBrowserUseCdpCommand(
        socket,
        { id: 1, method: "Target.getTargets", params: {} },
        cdpSignal,
      ),
      { reportInput: true },
    );
    const pageTargets = targets.targetInfos.filter((target) => {
      return target.type === "page";
    });
    if (pageTargets.length === 0) {
      throw new Error("Browser Use CDP returned no page target");
    }

    let commandId = 2;
    let focusedSessionId: string | null = null;
    let fallbackSessionId: string | null = null;
    for (const target of pageTargets) {
      const attached = browserUseCdpAttachedTargetSchema.parse(
        await sendBrowserUseCdpCommand(
          socket,
          {
            id: commandId,
            method: "Target.attachToTarget",
            params: { targetId: target.targetId, flatten: true },
          },
          cdpSignal,
        ),
        { reportInput: true },
      );
      commandId += 1;
      fallbackSessionId = attached.sessionId;
      const focus = browserUseCdpFocusSchema.parse(
        await sendBrowserUseCdpCommand(
          socket,
          {
            id: commandId,
            method: "Runtime.evaluate",
            params: {
              expression: "document.hasFocus()",
              returnByValue: true,
            },
            sessionId: attached.sessionId,
          },
          cdpSignal,
        ),
        { reportInput: true },
      );
      commandId += 1;
      if (focus.result.value === true) {
        focusedSessionId = attached.sessionId;
        break;
      }
    }

    const sessionId = focusedSessionId ?? fallbackSessionId;
    if (!sessionId) {
      throw new Error("Browser Use CDP could not attach to a page target");
    }
    const layout = browserUseCdpLayoutMetricsSchema.parse(
      await sendBrowserUseCdpCommand(
        socket,
        {
          id: commandId,
          method: "Page.getLayoutMetrics",
          params: {},
          sessionId,
        },
        cdpSignal,
      ),
      { reportInput: true },
    );
    commandId += 1;
    const viewport = layout.cssVisualViewport;
    const screenshot = browserUseCdpScreenshotSchema.parse(
      await sendBrowserUseCdpCommand(
        socket,
        {
          id: commandId,
          method: "Page.captureScreenshot",
          params: {
            format: "webp",
            quality: BROWSER_USE_SCREENSHOT_QUALITY,
            fromSurface: true,
            captureBeyondViewport: false,
            clip: {
              x: viewport.pageX,
              y: viewport.pageY,
              width: viewport.clientWidth,
              height: viewport.clientHeight,
              scale: BROWSER_USE_SCREENSHOT_WIDTH / viewport.clientWidth,
            },
          },
          sessionId,
          maxResponseBytes: MAX_BROWSER_USE_SCREENSHOT_RESPONSE_BYTES,
        },
        cdpSignal,
      ),
      { reportInput: true },
    );
    return Buffer.from(screenshot.data, "base64");
  });
}

interface AttachedBrowserUsePage {
  readonly targetId: string;
  readonly sessionId: string;
  readonly url: string;
}

async function attachBrowserUsePage(
  socket: WebSocket,
  target: { readonly targetId: string; readonly url: string },
  commandId: number,
  signal: AbortSignal,
): Promise<AttachedBrowserUsePage> {
  const attached = browserUseCdpAttachedTargetSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: commandId,
        method: "Target.attachToTarget",
        params: { targetId: target.targetId, flatten: true },
      },
      signal,
    ),
    { reportInput: true },
  );
  return { ...target, sessionId: attached.sessionId };
}

function httpPageUrl(value: string): URL | null {
  if (!URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

export interface BrowserUseSelectOption {
  readonly index: number;
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly selected: boolean;
  readonly empty: boolean;
}

export interface BrowserUseControlInspection {
  readonly tagName: string;
  readonly inputType: string;
  readonly connected: boolean;
  readonly mainDocument: boolean;
  readonly writable: boolean;
  readonly siteRequired: boolean;
  readonly multiple: boolean;
  readonly checked?: boolean;
  readonly accept?: string;
  readonly files?: readonly {
    readonly name: string;
    readonly size: number;
    readonly type: string;
  }[];
  readonly fileSetFingerprint?: string;
  readonly radioGroupFingerprint?: string;
  readonly radioOptions?: readonly {
    readonly index: number;
    readonly label: string;
    readonly disabled: boolean;
    readonly selected: boolean;
  }[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly min?: string;
  readonly max?: string;
  readonly step?: string;
  readonly options?: readonly BrowserUseSelectOption[];
  readonly optionSetFingerprint?: string;
}

function boundedOptionalControlLength(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 4096)
  );
}

function boundedOptionalControlPattern(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "string" && value.length <= 512)
  );
}

function boundedOptionalNumberConstraint(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length <= BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH)
  );
}

function boundedOptionalControlMetadata(
  candidate: Readonly<Record<string, unknown>>,
): boolean {
  return (
    boundedOptionalControlLength(candidate.minLength) &&
    boundedOptionalControlLength(candidate.maxLength) &&
    boundedOptionalControlPattern(candidate.pattern) &&
    boundedOptionalNumberConstraint(candidate.min) &&
    boundedOptionalNumberConstraint(candidate.max) &&
    boundedOptionalNumberConstraint(candidate.step)
  );
}

function safeSelectOptions(
  value: unknown,
): readonly BrowserUseSelectOption[] | null {
  if (!Array.isArray(value) || value.length > BROWSER_USER_ACTION_MAX_OPTIONS) {
    return null;
  }
  const options: BrowserUseSelectOption[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const option = entry as Record<string, unknown>;
    if (
      option.index !== index ||
      typeof option.label !== "string" ||
      option.label.length > BROWSER_USER_ACTION_MAX_OPTION_LABEL_LENGTH ||
      typeof option.value !== "string" ||
      option.value.length > BROWSER_USER_ACTION_MAX_OPTION_VALUE_LENGTH ||
      typeof option.disabled !== "boolean" ||
      typeof option.selected !== "boolean" ||
      option.empty !== (option.value === "")
    ) {
      return null;
    }
    options.push({
      index,
      label: option.label,
      value: option.value,
      disabled: option.disabled,
      selected: option.selected,
      empty: option.empty,
    });
  }
  return options;
}

function optionalControlMetadata(candidate: Record<string, unknown>) {
  return {
    ...(candidate.minLength === undefined
      ? {}
      : { minLength: candidate.minLength as number }),
    ...(candidate.maxLength === undefined
      ? {}
      : { maxLength: candidate.maxLength as number }),
    ...(candidate.pattern === undefined
      ? {}
      : { pattern: candidate.pattern as string }),
    ...(candidate.min === undefined ? {} : { min: candidate.min as string }),
    ...(candidate.max === undefined ? {} : { max: candidate.max as string }),
    ...(candidate.step === undefined ? {} : { step: candidate.step as string }),
  };
}

function validCheckboxInspection(
  candidate: Readonly<Record<string, unknown>>,
): boolean {
  return (
    (candidate.checked === undefined ||
      typeof candidate.checked === "boolean") &&
    (candidate.inputType !== "checkbox" ||
      typeof candidate.checked === "boolean")
  );
}

function optionalCheckboxMetadata(
  candidate: Readonly<Record<string, unknown>>,
) {
  return candidate.checked === undefined
    ? {}
    : { checked: candidate.checked as boolean };
}

function validObservedFile(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }
  const file = entry as Record<string, unknown>;
  return (
    typeof file.name === "string" &&
    file.name.length > 0 &&
    file.name.length <= BROWSER_USER_ACTION_MAX_FILE_NAME_LENGTH &&
    typeof file.type === "string" &&
    file.type.length <= BROWSER_USER_ACTION_MAX_FILE_TYPE_LENGTH &&
    typeof file.size === "number" &&
    Number.isSafeInteger(file.size) &&
    file.size >= 0 &&
    file.size <= BROWSER_USER_ACTION_MAX_OBSERVED_FILE_BYTES
  );
}

function validFileInspection(
  candidate: Readonly<Record<string, unknown>>,
): boolean {
  if (candidate.inputType !== "file" || !candidate.writable) {
    return true;
  }
  return (
    typeof candidate.accept === "string" &&
    candidate.accept.length <= BROWSER_USER_ACTION_MAX_ACCEPT_LENGTH &&
    Array.isArray(candidate.files) &&
    candidate.files.length <= BROWSER_USER_ACTION_MAX_FILES &&
    candidate.files.every(validObservedFile)
  );
}

function validControlShape(
  candidate: Readonly<Record<string, unknown>>,
): candidate is Readonly<Record<string, unknown>> &
  Pick<
    BrowserUseControlInspection,
    | "tagName"
    | "inputType"
    | "connected"
    | "mainDocument"
    | "writable"
    | "siteRequired"
    | "multiple"
  > {
  return (
    typeof candidate.tagName === "string" &&
    candidate.tagName.length <= 64 &&
    typeof candidate.inputType === "string" &&
    candidate.inputType.length <= 64 &&
    typeof candidate.connected === "boolean" &&
    typeof candidate.mainDocument === "boolean" &&
    typeof candidate.writable === "boolean" &&
    typeof candidate.siteRequired === "boolean" &&
    typeof candidate.multiple === "boolean" &&
    validCheckboxInspection(candidate) &&
    boundedOptionalControlMetadata(candidate)
  );
}

function safeControlInspection(
  value: unknown,
): BrowserUseControlInspection | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (!validControlShape(candidate) || !validFileInspection(candidate)) {
    return null;
  }
  const options =
    candidate.tagName === "SELECT"
      ? safeSelectOptions(candidate.options)
      : undefined;
  if (
    candidate.tagName === "SELECT" &&
    candidate.writable &&
    options === null
  ) {
    return null;
  }
  return {
    tagName: candidate.tagName,
    inputType: candidate.inputType,
    connected: candidate.connected,
    mainDocument: candidate.mainDocument,
    writable: candidate.writable,
    siteRequired: candidate.siteRequired,
    multiple: candidate.multiple,
    ...optionalCheckboxMetadata(candidate),
    ...optionalControlMetadata(candidate),
    ...(candidate.inputType === "file" && candidate.writable
      ? {
          accept: candidate.accept as string,
          files: candidate.files as BrowserUseControlInspection["files"],
          fileSetFingerprint: createHash("sha256")
            .update(
              JSON.stringify({
                accept: candidate.accept,
                multiple: candidate.multiple,
                required: candidate.siteRequired,
                files: candidate.files,
              }),
            )
            .digest("hex"),
        }
      : {}),
    ...(options === undefined || options === null
      ? {}
      : {
          options,
          optionSetFingerprint: createHash("sha256")
            .update(
              JSON.stringify({
                mode: candidate.inputType,
                required: candidate.siteRequired,
                options,
              }),
            )
            .digest("hex"),
        }),
  };
}

function browserUseControlInspectionFunction(): string {
  return `function (...otherControls) {
    const controls = [this, ...otherControls];
    const supportedInputTypes = new Set([
      "text", "password", "email", "tel", "url", "search", "number",
      "date", "time", "datetime-local", "month", "week", "checkbox", "radio", "file"
    ]);
    const dateTimeTypes = new Set(["date", "time", "datetime-local", "month", "week"]);
    return controls.map((control) => {
      const input = control instanceof HTMLInputElement;
      const textarea = control instanceof HTMLTextAreaElement;
      const select = control instanceof HTMLSelectElement;
      const options = select ? [...control.options] : [];
      const boundedOptions = !select || (options.length > 0 && options.length <= ${BROWSER_USER_ACTION_MAX_OPTIONS} &&
        options.every((option) => option.label.length <= ${BROWSER_USER_ACTION_MAX_OPTION_LABEL_LENGTH} &&
          option.value.length <= ${BROWSER_USER_ACTION_MAX_OPTION_VALUE_LENGTH}));
      const supported =
        textarea || select || (input && supportedInputTypes.has(control.type));
      const textual = supported && (textarea || !["number", "date", "time", "datetime-local", "month", "week", "checkbox", "radio", "file"].includes(control.type));
      const constrained = input && (control.type === "number" || dateTimeTypes.has(control.type));
      const file = input && control.type === "file";
      const boundedFiles = !file || (!control.webkitdirectory &&
        control.accept.length <= ${BROWSER_USER_ACTION_MAX_ACCEPT_LENGTH} &&
        control.files.length <= ${BROWSER_USER_ACTION_MAX_FILES} &&
        [...control.files].every((item) => item.name.length > 0 &&
          item.name.length <= ${BROWSER_USER_ACTION_MAX_FILE_NAME_LENGTH} &&
          item.type.length <= ${BROWSER_USER_ACTION_MAX_FILE_TYPE_LENGTH} &&
          Number.isSafeInteger(item.size) && item.size <= ${BROWSER_USER_ACTION_MAX_OBSERVED_FILE_BYTES}));
      const boundedNumberConstraints = !constrained ||
        [control.min, control.max, control.step].every((value) =>
          value.length <= ${BROWSER_USER_ACTION_MAX_NUMBER_CONSTRAINT_LENGTH});
      return {
        tagName: typeof control.tagName === "string" ? control.tagName : "",
        inputType: input ? control.type : textarea ? "textarea" : select ? (control.multiple ? "select-multiple" : "select-one") : "",
        connected: control.isConnected === true,
        mainDocument: control.ownerDocument === document,
        writable: supported && boundedFiles && boundedNumberConstraints && boundedOptions && !control.readOnly && !control.matches(":disabled") && !(input && control.type === "checkbox" && control.indeterminate),
        siteRequired: supported && control.required === true,
        ...(input && control.type === "checkbox" ? { checked: control.checked } : {}),
        multiple: select ? control.multiple : input && (control.type === "email" || file) && control.multiple === true,
        ...(file && boundedFiles ? { accept: control.accept, files: [...control.files].map((item) => ({
          name: item.name, size: item.size, type: item.type,
        })) } : {}),
        ...(select && boundedOptions ? { options: options.map((option, index) => ({
          index, label: option.label, value: option.value,
          disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
          selected: option.selected, empty: option.value === "",
        })) } : {}),
        ...(textual && control.minLength >= 0 && control.minLength <= 4096
          ? { minLength: control.minLength } : {}),
        ...(textual && control.maxLength >= 0 && control.maxLength <= 4096
          ? { maxLength: control.maxLength } : {}),
        ...(textual && input && control.pattern && control.pattern.length <= 512
          ? { pattern: control.pattern } : {}),
        ...(constrained && boundedNumberConstraints && control.min
          ? { min: control.min } : {}),
        ...(constrained && boundedNumberConstraints && control.max
          ? { max: control.max } : {}),
        ...(constrained && boundedNumberConstraints && control.step
          ? { step: control.step } : {}),
      };
    });
  }`;
}

function safeControlInspections(
  value: unknown,
  expectedLength: number,
): readonly NonNullable<ReturnType<typeof safeControlInspection>>[] | null {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    return null;
  }
  const inspections: NonNullable<ReturnType<typeof safeControlInspection>>[] =
    [];
  for (const item of value) {
    const inspection = safeControlInspection(item);
    if (!inspection) {
      return null;
    }
    inspections.push(inspection);
  }
  return inspections;
}

async function inspectBrowserUseControls(
  socket: WebSocket,
  sessionId: string,
  objectIds: readonly string[],
  commandId: number,
  signal: AbortSignal,
): Promise<readonly BrowserUseControlInspection[]> {
  const [firstObjectId, ...otherObjectIds] = objectIds;
  if (!firstObjectId) {
    return [];
  }
  const inspected = browserUseCdpValueSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: commandId,
        method: "Runtime.callFunctionOn",
        params: {
          objectId: firstObjectId,
          functionDeclaration: browserUseControlInspectionFunction(),
          arguments: otherObjectIds.map((objectId) => {
            return { objectId };
          }),
          returnByValue: true,
        },
        sessionId,
      },
      signal,
    ),
    { reportInput: true },
  );
  const inspections = safeControlInspections(
    inspected.result.value,
    objectIds.length,
  );
  if (!inspections) {
    throw new Error("Browser Use CDP control inspection failed");
  }
  return inspections;
}

interface BrowserUseRadioGroup {
  readonly name: string;
  readonly formOwnerObjectId: string | null;
  readonly memberNodeIds: readonly number[];
  readonly memberObjectIds: readonly string[];
  readonly options: readonly {
    readonly index: number;
    readonly label: string;
    readonly value: string;
    readonly disabled: boolean;
    readonly selected: boolean;
    readonly required: boolean;
  }[];
  readonly fingerprint: string;
  readonly siteRequired: boolean;
  readonly selectedIndex: number;
}

const browserUseRadioOptionSchema = z
  .object({
    label: z.string().min(1).max(BROWSER_USER_ACTION_MAX_OPTION_LABEL_LENGTH),
    value: z.string().max(BROWSER_USER_ACTION_MAX_OPTION_VALUE_LENGTH),
    disabled: z.boolean(),
    selected: z.boolean(),
    required: z.boolean(),
    writable: z.boolean(),
  })
  .strict();

async function readBrowserUseRadioMembers(
  socket: WebSocket,
  args: {
    readonly sessionId: string;
    readonly arrayObjectId: string;
    readonly anchorObjectId: string;
    readonly formOwnerObjectId: string | null;
    readonly memberObjectIds: readonly string[];
    readonly firstCommandId: number;
  },
  signal: AbortSignal,
): Promise<{
  readonly name: string | null;
  readonly options:
    | readonly z.infer<typeof browserUseRadioOptionSchema>[]
    | null;
  readonly memberNodeIds: readonly number[];
  readonly commandId: number;
}> {
  const { sessionId, arrayObjectId, anchorObjectId, memberObjectIds } = args;
  let commandId = args.firstCommandId;
  const metadata = z
    .object({ result: z.object({ value: z.unknown().optional() }) })
    .parse(
      await sendBrowserUseCdpCommand(
        socket,
        {
          id: commandId++,
          method: "Runtime.callFunctionOn",
          sessionId,
          params: {
            objectId: arrayObjectId,
            functionDeclaration: `function(anchor, owner) {
        if (!Array.isArray(this) || !(anchor instanceof HTMLInputElement) ||
            anchor.type !== "radio" || anchor.getRootNode() !== document || !anchor.name ||
            anchor.form !== owner ||
            !this.includes(anchor)) return null;
        const members = [...document.querySelectorAll("input")].filter((node) =>
          node.type === "radio" && node.getRootNode() === document &&
          node.name === anchor.name && node.form === anchor.form);
        if (members.length !== this.length || members.some((node, i) => node !== this[i])) return null;
        const options = members.map((node) => ({
          label: (node.getAttribute("aria-label") || [...(node.labels || [])].map((label) => label.textContent || "").join(" ")).trim(),
          value: node.value, disabled: node.matches(":disabled"), selected: node.checked,
          required: node.required, writable: !node.readOnly,
        }));
        return options.filter((option) => option.selected).length <= 1
          ? { name: anchor.name, options } : null;
      }`,
            arguments: [
              { objectId: anchorObjectId },
              args.formOwnerObjectId
                ? { objectId: args.formOwnerObjectId }
                : { value: null },
            ],
            returnByValue: true,
          },
        },
        signal,
      ),
      { reportInput: true },
    );
  const metadataSchema = z.object({
    name: z.string().min(1).max(128),
    options: z
      .array(browserUseRadioOptionSchema)
      .length(memberObjectIds.length),
  });
  const parsed = metadataSchema.safeParse(metadata.result.value);
  if (
    !parsed.success ||
    parsed.data.options.some((option) => {
      return !option.writable;
    })
  ) {
    return { name: null, options: null, memberNodeIds: [], commandId };
  }
  const memberNodeIds: number[] = [];
  for (const objectId of memberObjectIds) {
    const description = z
      .object({
        node: z.object({
          backendNodeId: z.number().int().positive().safe(),
          nodeName: z.literal("INPUT"),
        }),
      })
      .safeParse(
        await sendBrowserUseCdpCommand(
          socket,
          {
            id: commandId++,
            method: "DOM.describeNode",
            sessionId,
            params: { objectId, depth: 0 },
          },
          signal,
        ),
      );
    if (!description.success) {
      return { name: null, options: null, memberNodeIds: [], commandId };
    }
    memberNodeIds.push(description.data.node.backendNodeId);
  }
  return {
    name: parsed.data.name,
    options: parsed.data.options,
    memberNodeIds,
    commandId,
  };
}

function browserUseRadioGroupFingerprint(
  name: string,
  formOwnerNodeId: number | null,
  memberNodeIds: readonly number[],
  options: readonly z.infer<typeof browserUseRadioOptionSchema>[],
  siteRequired: boolean,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        name,
        formOwnerNodeId,
        memberNodeIds,
        siteRequired,
        options: options.map(({ label, value, disabled }) => {
          return { label, value, disabled };
        }),
      }),
    )
    .digest("hex");
}

function browserUseRadioGroupOptions(
  options: readonly z.infer<typeof browserUseRadioOptionSchema>[],
): BrowserUseRadioGroup["options"] {
  return options.map((option, index) => {
    return {
      index,
      label: option.label,
      value: option.value,
      disabled: option.disabled,
      selected: option.selected,
      required: option.required,
    };
  });
}

async function readBrowserUseRadioGroupHandles(
  socket: WebSocket,
  sessionId: string,
  arrayObjectId: string,
  firstCommandId: number,
  signal: AbortSignal,
): Promise<{
  readonly handles: {
    readonly memberObjectIds: readonly string[];
    readonly formOwnerObjectId: string | null;
    readonly formOwnerNodeId: number | null;
  } | null;
  readonly commandId: number;
}> {
  let commandId = firstCommandId;
  const properties = z
    .object({
      result: z.array(
        z
          .object({
            name: z.string(),
            value: z
              .object({
                objectId: z.string().min(1).optional(),
                subtype: z.string().optional(),
                value: z.unknown().optional(),
              })
              .optional(),
          })
          .passthrough(),
      ),
    })
    .parse(
      await sendBrowserUseCdpCommand(
        socket,
        {
          id: commandId++,
          method: "Runtime.getProperties",
          sessionId,
          params: { objectId: arrayObjectId, ownProperties: true },
        },
        signal,
      ),
      { reportInput: true },
    );
  const indexed = properties.result
    .filter((property) => {
      return /^(0|[1-9][0-9]*)$/u.test(property.name);
    })
    .sort((left, right) => {
      return Number(left.name) - Number(right.name);
    });
  if (
    indexed.length < 1 ||
    indexed.length > BROWSER_USER_ACTION_MAX_RADIO_MEMBERS ||
    indexed.some((property, index) => {
      return Number(property.name) !== index || !property.value?.objectId;
    })
  ) {
    return { handles: null, commandId };
  }
  const formOwner = properties.result.find((property) => {
    return property.name === "formOwner";
  })?.value;
  if (
    !formOwner ||
    (!formOwner.objectId &&
      (formOwner.subtype !== "null" || formOwner.value !== null))
  ) {
    return { handles: null, commandId };
  }
  const formOwnerObjectId = formOwner.objectId ?? null;
  let formOwnerNodeId: number | null = null;
  if (formOwnerObjectId) {
    const description = z
      .object({
        node: z.object({
          backendNodeId: z.number().int().positive().safe(),
          nodeName: z.literal("FORM"),
        }),
      })
      .safeParse(
        await sendBrowserUseCdpCommand(
          socket,
          {
            id: commandId++,
            method: "DOM.describeNode",
            sessionId,
            params: { objectId: formOwnerObjectId, depth: 0 },
          },
          signal,
        ),
      );
    if (!description.success) {
      return { handles: null, commandId };
    }
    formOwnerNodeId = description.data.node.backendNodeId;
  }
  return {
    handles: {
      memberObjectIds: indexed.map((property) => {
        return property.value?.objectId ?? "";
      }),
      formOwnerObjectId,
      formOwnerNodeId,
    },
    commandId,
  };
}

/** Discover actual same-form/name radios without trusting their possibly duplicate values. */
async function inspectBrowserUseRadioGroup(
  socket: WebSocket,
  sessionId: string,
  anchorObjectId: string,
  firstCommandId: number,
  signal: AbortSignal,
): Promise<{
  readonly group: BrowserUseRadioGroup | null;
  readonly commandId: number;
}> {
  let commandId = firstCommandId;
  const arrayResult = z
    .object({ result: z.object({ objectId: z.string().min(1).optional() }) })
    .parse(
      await sendBrowserUseCdpCommand(
        socket,
        {
          id: commandId++,
          method: "Runtime.callFunctionOn",
          sessionId,
          params: {
            objectId: anchorObjectId,
            functionDeclaration: `function(limit) {
        if (!(this instanceof HTMLInputElement) || this.type !== "radio" ||
            this.getRootNode() !== document || !this.name || this.name.length > 128) return null;
        const members = [...document.querySelectorAll("input")].filter((node) =>
          node.type === "radio" && node.getRootNode() === document &&
          node.name === this.name && node.form === this.form);
        if (members.length < 1 || members.length > limit) return null;
        Object.defineProperty(members, "formOwner", { value: this.form });
        return members;
      }`,
            arguments: [{ value: BROWSER_USER_ACTION_MAX_RADIO_MEMBERS }],
            returnByValue: false,
          },
        },
        signal,
      ),
      { reportInput: true },
    );
  const arrayObjectId = arrayResult.result.objectId;
  if (!arrayObjectId) {
    return { group: null, commandId };
  }
  const resolved = await readBrowserUseRadioGroupHandles(
    socket,
    sessionId,
    arrayObjectId,
    commandId,
    signal,
  );
  commandId = resolved.commandId;
  if (!resolved.handles) {
    return { group: null, commandId };
  }
  const { memberObjectIds, formOwnerObjectId, formOwnerNodeId } =
    resolved.handles;
  const observed = await readBrowserUseRadioMembers(
    socket,
    {
      sessionId,
      arrayObjectId,
      anchorObjectId,
      formOwnerObjectId,
      memberObjectIds,
      firstCommandId: commandId,
    },
    signal,
  );
  commandId = observed.commandId;
  const { name, options, memberNodeIds } = observed;
  if (
    !name ||
    !options ||
    new Set(memberNodeIds).size !== memberNodeIds.length
  ) {
    return { group: null, commandId };
  }
  const siteRequired = options.some((option) => {
    return option.required;
  });
  const fingerprint = browserUseRadioGroupFingerprint(
    name,
    formOwnerNodeId,
    memberNodeIds,
    options,
    siteRequired,
  );
  return {
    group: {
      name,
      formOwnerObjectId,
      memberNodeIds,
      memberObjectIds,
      siteRequired,
      fingerprint,
      selectedIndex: options.findIndex((option) => {
        return option.selected;
      }),
      options: browserUseRadioGroupOptions(options),
    },
    commandId,
  };
}

async function observeBrowserUseAttach(
  socket: WebSocket,
  targetInfo: { readonly targetId: string; readonly url: string },
  id: number,
  signal: AbortSignal,
  observePhase?: BrowserUseCdpPhaseObserver,
): Promise<AttachedBrowserUsePage> {
  let attachReplyObserved = false;
  // Observe only whether the matching reply reaches this socket. Never retain
  // or log the response body, which contains a provider session identifier.
  const onAttachMessage = (event: MessageEvent) => {
    if (
      typeof event.data !== "string" ||
      event.data.length > MAX_BROWSER_USE_CDP_RESPONSE_BYTES
    ) {
      return;
    }
    const response = browserUseCdpResponseSchema.safeParse(
      safeJsonParse(event.data),
    );
    if (response.success && response.data.id === id) {
      attachReplyObserved = true;
    }
  };
  if (observePhase) {
    socket.addEventListener("message", onAttachMessage);
  }
  const attachment = await settleIncludingAbort(
    observeBrowserUseCdpPhase(
      "attach",
      signal,
      observePhase
        ? (phase, outcome, durationMs) => {
            observePhase(phase, outcome, durationMs, attachReplyObserved);
          }
        : undefined,
      async () => {
        return await attachBrowserUsePage(socket, targetInfo, id, signal);
      },
    ),
  );
  if (observePhase) {
    socket.removeEventListener("message", onAttachMessage);
  }
  if (!attachment.ok) {
    throw attachment.error;
  }
  return attachment.value;
}

async function openBrowserUseValidationPage(
  socket: WebSocket,
  pageTargetId: string,
  signal: AbortSignal,
  observePhase?: BrowserUseCdpPhaseObserver,
): Promise<{
  readonly page: AttachedBrowserUsePage;
  readonly commandId: number;
}> {
  const targets = await observeBrowserUseCdpPhase(
    "targets",
    signal,
    observePhase,
    async () => {
      return browserUseCdpTargetsSchema.parse(
        await sendBrowserUseCdpCommand(
          socket,
          { id: 1, method: "Target.getTargets", params: {} },
          signal,
        ),
        { reportInput: true },
      );
    },
  );
  const pageTarget = targets.targetInfos.find((target) => {
    return target.type === "page" && target.targetId === pageTargetId;
  });
  if (!pageTarget) {
    throw new BrowserUseUserActionValidationError("page_target_not_found");
  }
  return {
    page: await observeBrowserUseAttach(
      socket,
      pageTarget,
      2,
      signal,
      observePhase,
    ),
    commandId: 3,
  };
}

async function resolveBrowserUseValidationControl(
  socket: WebSocket,
  args: {
    readonly sessionId: string;
    readonly backendNodeId: number;
    readonly commandId: number;
    readonly fieldPosition: number;
  },
  signal: AbortSignal,
): Promise<{
  readonly objectId: string;
  readonly commandId: number;
}> {
  const resolved = await settle(
    sendBrowserUseCdpCommand(
      socket,
      {
        id: args.commandId,
        method: "DOM.resolveNode",
        params: { backendNodeId: args.backendNodeId },
        sessionId: args.sessionId,
      },
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!resolved.ok) {
    if (!isMissingBrowserUseNode(resolved.error)) {
      throw resolved.error;
    }
    throw new BrowserUseUserActionValidationError(
      "backend_node_not_found",
      args.fieldPosition,
    );
  }
  const remote = browserUseCdpRemoteObjectSchema.safeParse(resolved.value);
  if (!remote.success) {
    throw new Error(
      "Browser Use CDP node resolution returned an invalid response",
    );
  }
  return {
    objectId: remote.data.object.objectId,
    commandId: args.commandId + 1,
  };
}

async function inspectBrowserUseCreationRadioGroups(
  socket: WebSocket,
  args: {
    readonly sessionId: string;
    readonly capturedControls: readonly {
      readonly backendNodeId: number;
      readonly objectId: string;
    }[];
    readonly inspections: readonly BrowserUseControlInspection[];
    readonly commandId: number;
  },
  signal: AbortSignal,
): Promise<readonly (BrowserUseRadioGroup | null)[]> {
  let commandId = args.commandId;
  const radioGroups: (BrowserUseRadioGroup | null)[] = [];
  for (const [index, control] of args.capturedControls.entries()) {
    if (args.inspections[index]?.inputType !== "radio") {
      radioGroups.push(null);
      continue;
    }
    const inspected = await inspectBrowserUseRadioGroup(
      socket,
      args.sessionId,
      control.objectId,
      commandId,
      signal,
    );
    commandId = inspected.commandId;
    if (
      !inspected.group ||
      !inspected.group.memberNodeIds.includes(control.backendNodeId)
    ) {
      throw new BrowserUseUserActionValidationError(
        "unsupported_control",
        index + 1,
      );
    }
    radioGroups.push(inspected.group);
  }
  const allIdentities = args.capturedControls.flatMap((control, index) => {
    return radioGroups[index]?.memberNodeIds ?? [control.backendNodeId];
  });
  if (new Set(allIdentities).size !== allIdentities.length) {
    throw new BrowserUseUserActionValidationError("unsupported_control");
  }
  return radioGroups;
}

async function validateBrowserUseUserActionOnSocket(
  socket: WebSocket,
  target: {
    readonly pageTargetId: string;
    readonly backendNodeIds: readonly number[];
  },
  signal: AbortSignal,
  observePhase?: BrowserUseCdpPhaseObserver,
): Promise<BrowserUseUserActionValidation> {
  const opened = await openBrowserUseValidationPage(
    socket,
    target.pageTargetId,
    signal,
    observePhase,
  );
  let commandId = opened.commandId;
  const frameTree = await observeBrowserUseCdpPhase(
    "frame",
    signal,
    observePhase,
    async () => {
      return browserUseCdpFrameTreeSchema.parse(
        await sendBrowserUseCdpCommand(
          socket,
          {
            id: commandId,
            method: "Page.getFrameTree",
            params: {},
            sessionId: opened.page.sessionId,
          },
          signal,
        ),
        { reportInput: true },
      );
    },
  );
  commandId += 1;
  const pageUrl = httpPageUrl(frameTree.frameTree.frame.url);
  if (!pageUrl) {
    throw new BrowserUseUserActionValidationError("unsupported_page");
  }
  const capturedControls: {
    readonly backendNodeId: number;
    readonly objectId: string;
  }[] = [];
  for (const [index, backendNodeId] of target.backendNodeIds.entries()) {
    const captured = await resolveBrowserUseValidationControl(
      socket,
      {
        sessionId: opened.page.sessionId,
        backendNodeId,
        commandId,
        fieldPosition: index + 1,
      },
      signal,
    );
    commandId = captured.commandId;
    capturedControls.push({ backendNodeId, objectId: captured.objectId });
  }
  const inspections = await inspectBrowserUseControls(
    socket,
    opened.page.sessionId,
    capturedControls.map((control) => {
      return control.objectId;
    }),
    commandId,
    signal,
  );
  const unsupportedPosition = inspections.findIndex((inspection) => {
    return (
      !inspection.connected ||
      !inspection.mainDocument ||
      !inspection.writable ||
      (inspection.tagName !== "INPUT" &&
        inspection.tagName !== "TEXTAREA" &&
        inspection.tagName !== "SELECT")
    );
  });
  if (unsupportedPosition !== -1) {
    throw new BrowserUseUserActionValidationError(
      "unsupported_control",
      unsupportedPosition + 1,
    );
  }
  const radioGroups = await inspectBrowserUseCreationRadioGroups(
    socket,
    {
      sessionId: opened.page.sessionId,
      capturedControls,
      inspections,
      commandId: commandId + 1,
    },
    signal,
  );
  const fields = capturedControls.map((control, index) => {
    const inspection = inspections[index];
    if (
      !inspection ||
      (inspection.tagName !== "INPUT" &&
        inspection.tagName !== "TEXTAREA" &&
        inspection.tagName !== "SELECT")
    ) {
      throw new BrowserUseUserActionValidationError(
        "unsupported_control",
        index + 1,
      );
    }
    return {
      backendNodeId: control.backendNodeId,
      ...(radioGroups[index]
        ? { radioMemberNodeIds: radioGroups[index].memberNodeIds }
        : {}),
      fingerprint: {
        tagName: inspection.tagName,
        inputType: inspection.inputType,
      },
    } satisfies BrowserUseUserActionTarget;
  });
  return {
    pageTargetId: opened.page.targetId,
    documentLoaderId: frameTree.frameTree.frame.loaderId,
    pageUrl: pageUrl.toString(),
    siteOrigin: pageUrl.origin,
    fields,
  };
}

/**
 * Validate CLI-resolved creation targets without querying or rediscovering
 * controls. The returned fingerprints are derived from the current document.
 */
export async function validateBrowserUseUserAction(
  cdpUrl: string,
  target: {
    readonly pageTargetId: string;
    readonly backendNodeIds: readonly number[];
  },
  signal: AbortSignal,
  attemptId: string,
): Promise<BrowserUseUserActionValidation> {
  return await withBrowserUseCdpDeadline(signal, async (cdpSignal) => {
    const observePhase = nativeInputCdpPhaseObserver("create", attemptId);
    return await withBrowserUseCdpSocket(
      cdpUrl,
      cdpSignal,
      async (socket) => {
        return await validateBrowserUseUserActionOnSocket(
          socket,
          target,
          cdpSignal,
          observePhase,
        );
      },
      observePhase,
    );
  });
}

export interface BrowserUseUserActionApplyField {
  readonly backendNodeId: number;
  readonly fingerprint: BrowserUseUserActionFingerprint;
  readonly radioMemberNodeIds?: readonly number[];
  readonly required?: boolean;
  readonly value?: string;
  readonly checkbox?: {
    readonly checked: boolean;
    readonly observedChecked: boolean;
  };
  readonly radioChoice?: {
    readonly memberIndex: number;
    readonly observedSelectedIndex: number;
    readonly groupFingerprint: string;
  };
  readonly selection?: {
    readonly optionIndexes: readonly number[];
    readonly optionSetFingerprint: string;
  };
  readonly fileChoice?: {
    readonly observedFingerprint: string;
    readonly operation: "keep" | "replace" | "clear";
    readonly files: readonly {
      readonly name: string;
      readonly type: string;
      readonly size: number;
      readonly contentBase64: string;
    }[];
  };
}

export interface BrowserUseUserActionExactTarget {
  readonly pageTargetId: string;
  readonly documentLoaderId: string;
  readonly pageUrlHash: string;
  readonly fields: readonly BrowserUseUserActionApplyField[];
}

function isMissingBrowserUseNode(error: unknown): boolean {
  return (
    error instanceof BrowserUseCdpCommandError &&
    /^(?:No node with given id found|Could not find node with given id|Node with given id does not belong to the document)/iu.test(
      error.message,
    )
  );
}

interface ResolvedBrowserUseUserActionField {
  readonly objectId: string;
  readonly required?: boolean;
  readonly value?: string;
  readonly radio?: BrowserUseRadioGroup;
  readonly radioChoice?: {
    readonly memberIndex: number;
    readonly observedSelectedIndex: number;
    readonly groupFingerprint: string;
  };
  readonly checkbox?: {
    readonly checked: boolean;
    readonly observedChecked: boolean;
  };
  readonly selection?: {
    readonly optionIndexes: readonly number[];
    readonly optionSetFingerprint: string;
  };
  readonly inspection: BrowserUseControlInspection;
}

interface WritableBrowserUseUserActionField {
  readonly objectId: string;
  readonly value: string;
}

async function openBrowserUseApplyPage(
  socket: WebSocket,
  target: BrowserUseUserActionExactTarget,
  signal: AbortSignal,
  observePhase?: BrowserUseCdpPhaseObserver,
): Promise<(AttachedBrowserUsePage & { readonly frameId: string }) | null> {
  const targets = await observeBrowserUseCdpPhase(
    "targets",
    signal,
    observePhase,
    async () => {
      return browserUseCdpTargetsSchema.parse(
        await sendBrowserUseCdpCommand(
          socket,
          { id: 1, method: "Target.getTargets", params: {} },
          signal,
        ),
        { reportInput: true },
      );
    },
  );
  const targetInfo = targets.targetInfos.find((candidate) => {
    return (
      candidate.type === "page" && candidate.targetId === target.pageTargetId
    );
  });
  if (!targetInfo) {
    return null;
  }
  const attached = await observeBrowserUseAttach(
    socket,
    targetInfo,
    2,
    signal,
    observePhase,
  );
  const frameTree = await observeBrowserUseCdpPhase(
    "frame",
    signal,
    observePhase,
    async () => {
      return browserUseCdpFrameTreeSchema.parse(
        await sendBrowserUseCdpCommand(
          socket,
          {
            id: 3,
            method: "Page.getFrameTree",
            params: {},
            sessionId: attached.sessionId,
          },
          signal,
        ),
        { reportInput: true },
      );
    },
  );
  const currentPageUrl = httpPageUrl(frameTree.frameTree.frame.url);
  if (
    frameTree.frameTree.frame.loaderId !== target.documentLoaderId ||
    !currentPageUrl ||
    createHash("sha256").update(currentPageUrl.toString()).digest("hex") !==
      target.pageUrlHash
  ) {
    return null;
  }
  return { ...attached, frameId: frameTree.frameTree.frame.id };
}

function checkboxObservationMatches(
  field: BrowserUseUserActionApplyField,
  inspection: BrowserUseControlInspection,
): boolean {
  return (
    field.checkbox === undefined ||
    inspection.checked === field.checkbox.observedChecked
  );
}

async function inspectBrowserUseApplyRadioGroups(
  socket: WebSocket,
  args: {
    readonly sessionId: string;
    readonly fields: readonly BrowserUseUserActionApplyField[];
    readonly objectIds: readonly string[];
    readonly commandId: number;
  },
  signal: AbortSignal,
): Promise<{
  readonly groups: readonly (BrowserUseRadioGroup | null)[];
  readonly commandId: number;
} | null> {
  let commandId = args.commandId;
  const groups: (BrowserUseRadioGroup | null)[] = [];
  for (const [index, field] of args.fields.entries()) {
    if (field.fingerprint.inputType !== "radio") {
      groups.push(null);
      continue;
    }
    const anchor = args.objectIds[index];
    if (!anchor || !field.radioMemberNodeIds) {
      return null;
    }
    const observed = await inspectBrowserUseRadioGroup(
      socket,
      args.sessionId,
      anchor,
      commandId,
      signal,
    );
    commandId = observed.commandId;
    if (
      !observed.group ||
      observed.group.memberNodeIds.length !== field.radioMemberNodeIds.length ||
      observed.group.memberNodeIds.some((id, position) => {
        return id !== field.radioMemberNodeIds?.[position];
      }) ||
      !observed.group.memberNodeIds.includes(field.backendNodeId)
    ) {
      return null;
    }
    groups.push(observed.group);
  }
  return { groups, commandId };
}

function browserUseApplyChoiceMatches(
  field: BrowserUseUserActionApplyField,
  inspection: BrowserUseControlInspection,
  radio: BrowserUseRadioGroup | null | undefined,
): boolean {
  return (
    checkboxObservationMatches(field, inspection) &&
    (field.radioChoice === undefined ||
      (radio !== null &&
        radio !== undefined &&
        field.radioChoice.groupFingerprint === radio.fingerprint &&
        field.radioChoice.observedSelectedIndex === radio.selectedIndex)) &&
    (field.selection === undefined ||
      inspection.optionSetFingerprint === field.selection.optionSetFingerprint)
  );
}

function resolveBrowserUseApplyField(
  field: BrowserUseUserActionApplyField,
  original: BrowserUseControlInspection | undefined,
  radio: BrowserUseRadioGroup | null | undefined,
  objectId: string | undefined,
): ResolvedBrowserUseUserActionField | null {
  const inspection =
    original && radio
      ? {
          ...original,
          siteRequired: radio.siteRequired,
          radioGroupFingerprint: radio.fingerprint,
          radioOptions: radio.options.map(
            ({ index, label, disabled, selected }) => {
              return { index, label, disabled, selected };
            },
          ),
        }
      : original;
  if (
    !inspection ||
    !objectId ||
    !inspection.connected ||
    !inspection.mainDocument ||
    !inspection.writable ||
    inspection.tagName !== field.fingerprint.tagName ||
    inspection.inputType !== field.fingerprint.inputType ||
    !browserUseApplyChoiceMatches(field, inspection, radio)
  ) {
    return null;
  }
  return {
    objectId,
    inspection,
    required: field.required,
    ...(radio ? { radio } : {}),
    ...(field.radioChoice === undefined
      ? {}
      : { radioChoice: field.radioChoice }),
    ...(field.value === undefined ? {} : { value: field.value }),
    ...(field.checkbox === undefined ? {} : { checkbox: field.checkbox }),
    ...(field.selection === undefined ? {} : { selection: field.selection }),
  };
}

async function resolveBrowserUseApplyFields(
  socket: WebSocket,
  sessionId: string,
  fields: readonly BrowserUseUserActionApplyField[],
  signal: AbortSignal,
): Promise<{
  readonly fields: readonly ResolvedBrowserUseUserActionField[];
  readonly commandId: number;
} | null> {
  let commandId = 4;
  const objectIds: string[] = [];
  for (const field of fields) {
    const remoteResult = await settle(
      sendBrowserUseCdpCommand(
        socket,
        {
          id: commandId,
          method: "DOM.resolveNode",
          params: { backendNodeId: field.backendNodeId },
          sessionId,
        },
        signal,
      ),
    );
    if (!remoteResult.ok) {
      if (isMissingBrowserUseNode(remoteResult.error)) {
        return null;
      }
      throw remoteResult.error;
    }
    const remote = browserUseCdpRemoteObjectSchema.safeParse(
      remoteResult.value,
    );
    if (!remote.success) {
      throw new Error("Browser Use CDP node resolution failed");
    }
    objectIds.push(remote.data.object.objectId);
    commandId += 1;
  }
  const inspections = await inspectBrowserUseControls(
    socket,
    sessionId,
    objectIds,
    commandId,
    signal,
  );
  commandId += objectIds.length === 0 ? 0 : 1;
  const radio = await inspectBrowserUseApplyRadioGroups(
    socket,
    { sessionId, fields, objectIds, commandId },
    signal,
  );
  if (!radio) {
    return null;
  }
  const resolved: ResolvedBrowserUseUserActionField[] = [];
  for (const [index, field] of fields.entries()) {
    const matched = resolveBrowserUseApplyField(
      field,
      inspections[index],
      radio.groups[index],
      objectIds[index],
    );
    if (!matched) {
      return null;
    }
    resolved.push(matched);
  }
  return { fields: resolved, commandId: radio.commandId };
}

/** Read the same sealed target as apply, without a Browser value write. */
export async function preflightBrowserUseUserAction(
  cdpUrl: string,
  target: BrowserUseUserActionExactTarget,
  signal: AbortSignal,
  attemptId: string,
): Promise<
  | {
      readonly kind: "valid";
      readonly controls: readonly BrowserUseControlInspection[];
    }
  | { readonly kind: "stale" }
> {
  return await withBrowserUseCdpDeadline(signal, async (cdpSignal) => {
    const observePhase = nativeInputCdpPhaseObserver("preflight", attemptId);
    return await withBrowserUseCdpSocket(
      cdpUrl,
      cdpSignal,
      async (socket) => {
        const attached = await observeBrowserUseCdpPhase(
          "target",
          cdpSignal,
          observePhase,
          async () => {
            return await openBrowserUseApplyPage(
              socket,
              target,
              cdpSignal,
              observePhase,
            );
          },
        );
        if (!attached) {
          return { kind: "stale" };
        }
        const resolved = await observeBrowserUseCdpPhase(
          "controls",
          cdpSignal,
          observePhase,
          async () => {
            return await resolveBrowserUseApplyFields(
              socket,
              attached.sessionId,
              target.fields,
              cdpSignal,
            );
          },
        );
        return resolved
          ? {
              kind: "valid",
              controls: resolved.fields.map((field) => {
                return field.inspection;
              }),
            }
          : { kind: "stale" };
      },
      observePhase,
    );
  });
}

function writableBrowserUseFields(
  fields: readonly ResolvedBrowserUseUserActionField[],
): readonly WritableBrowserUseUserActionField[] {
  const writable: WritableBrowserUseUserActionField[] = [];
  for (const field of fields) {
    if (field.value !== undefined) {
      writable.push({ objectId: field.objectId, value: field.value });
    }
  }
  return writable;
}

function browserUseAggregateValueArguments(
  fields: readonly WritableBrowserUseUserActionField[],
): readonly Readonly<Record<string, unknown>>[] {
  const [, ...otherFields] = fields;
  return otherFields.flatMap((field) => {
    return [{ objectId: field.objectId }, { value: field.value }];
  });
}

function validSelectApplyFields(
  fields: readonly ResolvedBrowserUseUserActionField[],
): boolean {
  for (const field of fields) {
    if (field.inspection.tagName !== "SELECT") {
      continue;
    }
    const options = field.inspection.options;
    if (
      !options ||
      !field.inspection.optionSetFingerprint ||
      field.value !== undefined
    ) {
      return false;
    }
    const selected = field.selection?.optionIndexes;
    if (selected === undefined) {
      if (
        (field.inspection.siteRequired || field.required) &&
        !options.some((option) => {
          return option.selected && !option.disabled && !option.empty;
        })
      ) {
        return false;
      }
      continue;
    }
    if (
      (field.inspection.inputType === "select-one" && selected.length > 1) ||
      selected.some((index) => {
        return !options[index] || options[index].disabled;
      }) ||
      ((field.inspection.siteRequired || field.required) &&
        selected.every((index) => {
          return options[index]?.empty || options[index]?.disabled;
        }))
    ) {
      return false;
    }
  }
  return true;
}

async function validateBrowserUseApplyValues(
  socket: WebSocket,
  args: {
    readonly sessionId: string;
    readonly fields: readonly ResolvedBrowserUseUserActionField[];
    readonly commandId: number;
  },
  signal: AbortSignal,
): Promise<boolean> {
  if (
    !validSelectApplyFields(args.fields) ||
    args.fields.some((field) => {
      return (
        field.radio &&
        ((field.required === true &&
          (field.radioChoice?.memberIndex ?? -1) < 0) ||
          (field.radio.siteRequired &&
            (field.radioChoice?.memberIndex ?? field.radio.selectedIndex) <
              0) ||
          (field.radioChoice !== undefined &&
            (field.radioChoice.memberIndex >= field.radio.options.length ||
              (field.radioChoice.memberIndex >= 0 &&
                field.radio.options[field.radioChoice.memberIndex]?.disabled) ||
              (field.radioChoice.memberIndex === -1 &&
                field.radio.selectedIndex >= 0 &&
                field.radio.options[field.radio.selectedIndex]?.disabled))))
      );
    }) ||
    args.fields.some((field) => {
      return (
        field.inspection.inputType === "checkbox" &&
        (field.inspection.checked === undefined ||
          (field.required === true && field.checkbox?.checked !== true) ||
          (field.inspection.siteRequired &&
            (field.checkbox?.checked ?? field.inspection.checked) !== true))
      );
    })
  ) {
    return false;
  }
  const scalarFields = args.fields.filter((field) => {
    return (
      field.inspection.tagName !== "SELECT" &&
      field.inspection.inputType !== "checkbox" &&
      field.inspection.inputType !== "radio"
    );
  });
  const [firstField, ...otherFields] = scalarFields;
  if (!firstField) {
    return true;
  }
  const checked = browserUseCdpValueSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: args.commandId,
        method: "Runtime.callFunctionOn",
        params: {
          objectId: firstField.objectId,
          functionDeclaration: `function (nextValue, ...otherControlValues) {
            const controls = [this];
            const values = [nextValue];
            for (let index = 0; index < otherControlValues.length; index += 2) {
              controls.push(otherControlValues[index]);
              values.push(otherControlValues[index + 1]);
            }
            return controls.every((control, index) => {
              const value = values[index];
              if (value === null) {
                return !control.required || (control.value !== "" &&
                  (!["date", "time", "datetime-local", "month", "week"].includes(control.type) || control.validity.valid));
              }
              if (typeof value !== "string") return false;
              if (control.minLength >= 0 && value.length < control.minLength) return false;
              if (control.maxLength >= 0 && value.length > control.maxLength) return false;
              const clone = control.cloneNode(false);
              clone.value = value;
              return clone.value === value && clone.checkValidity();
            });
          }`,
          arguments: [
            { value: firstField.value ?? null },
            ...otherFields.flatMap((field) => {
              return [
                { objectId: field.objectId },
                { value: field.value ?? null },
              ];
            }),
          ],
          returnByValue: true,
        },
        sessionId: args.sessionId,
      },
      signal,
    ),
    { reportInput: true },
  );
  return checked.result.value === true;
}

async function writeBrowserUseApplyFields(
  socket: WebSocket,
  args: {
    readonly sessionId: string;
    readonly fields: readonly ResolvedBrowserUseUserActionField[];
    readonly commandId: number;
  },
  mutation: { writeStarted: boolean },
  signal: AbortSignal,
): Promise<void> {
  const fields = writableBrowserUseFields(args.fields);
  const [firstField] = fields;
  if (!firstField) {
    return;
  }
  const remainingArguments = browserUseAggregateValueArguments(fields);
  mutation.writeStarted = true;
  const wrote = browserUseCdpValueSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: args.commandId,
        method: "Runtime.callFunctionOn",
        params: {
          objectId: firstField.objectId,
          functionDeclaration: `function (nextValue, ...otherControlValues) {
            const controls = [this];
            const values = [nextValue];
            for (let index = 0; index < otherControlValues.length; index += 2) {
              controls.push(otherControlValues[index]);
              values.push(otherControlValues[index + 1]);
            }
            for (let index = 0; index < controls.length; index += 1) {
              const control = controls[index];
              const prototype = control instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
              if (!setter) throw new Error("native setter unavailable");
              setter.call(control, values[index]);
              control.dispatchEvent(new Event("input", { bubbles: true }));
              control.dispatchEvent(new Event("change", { bubbles: true }));
            }
            return true;
          }`,
          arguments: [{ value: firstField.value }, ...remainingArguments],
          awaitPromise: false,
          returnByValue: true,
        },
        sessionId: args.sessionId,
      },
      signal,
    ),
    { reportInput: true },
  );
  if (wrote.result.value !== true) {
    throw new BrowserUseUserActionMutationError(true);
  }
  const verified = browserUseCdpValueSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: args.commandId + 1,
        method: "Runtime.callFunctionOn",
        params: {
          objectId: firstField.objectId,
          functionDeclaration: `function (expected, ...otherControlValues) {
            const controls = [this];
            const expectedValues = [expected];
            for (let index = 0; index < otherControlValues.length; index += 2) {
              controls.push(otherControlValues[index]);
              expectedValues.push(otherControlValues[index + 1]);
            }
            return controls.every((control, index) => {
              return control.isConnected &&
                control.ownerDocument === document &&
                control.value === expectedValues[index];
            });
          }`,
          arguments: [{ value: firstField.value }, ...remainingArguments],
          returnByValue: true,
        },
        sessionId: args.sessionId,
      },
      signal,
    ),
    { reportInput: true },
  );
  if (verified.result.value !== true) {
    throw new BrowserUseUserActionMutationError(true);
  }
}

function browserUseMixedControlWriterFunction(): string {
  return `function (firstSpec, otherCount, ...rest) {
          const controls = [this];
          const specs = [firstSpec];
          for (let index = 0; index < otherCount; index++) {
            controls.push(rest[index * 2]);
            specs.push(rest[index * 2 + 1]);
          }
          let memberOffset = otherCount * 2;
          for (const spec of specs) {
            if (spec.kind !== "radio") continue;
            spec.members = rest.slice(memberOffset, memberOffset + spec.memberCount);
            spec.owner = rest[memberOffset + spec.memberCount];
            memberOffset += spec.memberCount + 1;
          }
          if (memberOffset !== rest.length) return false;
          const matches = (control, spec, final) => {
            if (!control.isConnected || control.ownerDocument !== document || control.matches(":disabled")) return false;
            if (spec.kind === "radio") {
              if (!(control instanceof HTMLInputElement) || control.type !== "radio" ||
                  control.getRootNode() !== document || control.name !== spec.name ||
                  control.form !== spec.owner || !spec.members.includes(control) ||
                  spec.members.length !== spec.options.length) return false;
              const current = [...document.querySelectorAll("input")].filter((node) =>
                node.type === "radio" && node.getRootNode() === document &&
                node.name === control.name && node.form === control.form);
              if (current.length !== spec.members.length ||
                  current.some((node, index) => node !== spec.members[index])) return false;
              return spec.members.every((node, index) => {
                const expected = spec.options[index];
                const label = (node.getAttribute("aria-label") || [...(node.labels || [])].map((item) => item.textContent || "").join(" ")).trim();
                const selected = final && spec.index !== null ? index === spec.index : expected.selected;
                return node instanceof HTMLInputElement && node.isConnected &&
                  node.type === "radio" && !node.readOnly && node.value === expected.value &&
                  node.matches(":disabled") === expected.disabled && node.required === expected.required &&
                  label === expected.label && node.checked === selected;
              });
            }
            if (spec.kind === "checkbox") {
              return control instanceof HTMLInputElement && control.type === "checkbox" &&
                !control.indeterminate && control.required === spec.required &&
                control.checked === (final && spec.checked !== null ? spec.checked : spec.observedChecked);
            }
            if (spec.kind === "scalar") {
              const actualType = control instanceof HTMLInputElement ? control.type
                : control instanceof HTMLTextAreaElement ? "textarea" : null;
              if (control.tagName !== spec.tagName || actualType !== spec.inputType || control.readOnly ||
                  control.required !== spec.required) return false;
              const dateTime = control instanceof HTMLInputElement &&
                ["date", "time", "datetime-local", "month", "week"].includes(control.type);
              const textual = control instanceof HTMLTextAreaElement ||
                (control instanceof HTMLInputElement && !["number", "date", "time", "datetime-local", "month", "week", "checkbox", "radio"].includes(control.type));
              const constrained = control instanceof HTMLInputElement && (control.type === "number" || dateTime);
              if ((control instanceof HTMLInputElement && control.type === "email" ? control.multiple : false) !== spec.multiple ||
                  (textual && (control.minLength !== (spec.minLength ?? -1) ||
                    control.maxLength !== (spec.maxLength ?? -1) ||
                    (control instanceof HTMLInputElement && (control.pattern || undefined) !== spec.pattern))) ||
                  (constrained && ((control.min || undefined) !== spec.min ||
                    (control.max || undefined) !== spec.max ||
                    (control.step || undefined) !== spec.step))) return false;
              if (spec.value === null) {
                if (!spec.required) return true;
                // Another control's handler can invalidate an untouched,
                // site-required field. Reading validity does not dispatch an
                // invalid event on the website's control.
                const value = control.value;
                return !(control.minLength >= 0 && value.length < control.minLength) &&
                  !(control.maxLength >= 0 && value.length > control.maxLength) &&
                  control.validity.valid;
              }
              return !final || (control.value === spec.value && (!dateTime || control.validity.valid));
            }
            if (!(control instanceof HTMLSelectElement) ||
                (control.multiple ? "select-multiple" : "select-one") !== spec.mode ||
                control.required !== spec.required || !spec.options ||
                control.options.length !== spec.options.length) return false;
            return spec.options.every((expected, index) => {
              const option = control.options[index];
              const disabled = option.disabled ||
                (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled);
              const selected = final && spec.indices !== null
                ? spec.indices.includes(index) : expected.selected;
              return option.label === expected.label && option.value === expected.value &&
                disabled === expected.disabled && option.selected === selected;
            });
          };
          if (firstSpec.verifyOnly === true) {
            return controls.every((control, index) => matches(control, specs[index], true));
          }
          if (!controls.every((control, index) => matches(control, specs[index], false))) return false;
          for (let index = 0; index < controls.length; index += 1) {
            const control = controls[index];
            const spec = specs[index];
            if (!matches(control, spec, false)) return false;
            if (spec.kind === "radio") {
              if (spec.index === null || spec.index === spec.selectedIndex) continue;
              const target = spec.members[spec.index < 0 ? spec.selectedIndex : spec.index];
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
              if (!target || !setter || target.matches(":disabled")) return false;
              setter.call(target, spec.index >= 0);
              target.dispatchEvent(new Event("input", { bubbles: true }));
              target.dispatchEvent(new Event("change", { bubbles: true }));
              continue;
            }
            if (spec.kind === "checkbox") {
              if (spec.checked === null || spec.checked === control.checked) continue;
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
              if (!setter) return false;
              setter.call(control, spec.checked);
            } else if (spec.kind === "scalar" && spec.value !== null) {
              const prototype = control instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
              if (!setter) return false;
              setter.call(control, spec.value);
            } else if (spec.kind === "select" && spec.indices !== null) {
              if (spec.indices.length === 0) control.selectedIndex = -1;
              else for (let optionIndex = 0; optionIndex < control.options.length; optionIndex += 1) {
                control.options[optionIndex].selected = spec.indices.includes(optionIndex);
              }
            } else continue;
            control.dispatchEvent(new Event("input", { bubbles: true }));
            control.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return controls.every((control, index) => matches(control, specs[index], true));
        }`;
}

function needsIndependentBrowserUseVerification(
  fields: readonly ResolvedBrowserUseUserActionField[],
): boolean {
  return fields.some((field) => {
    return (
      field.radio !== undefined ||
      ["date", "time", "datetime-local", "month", "week"].includes(
        field.inspection.inputType,
      )
    );
  });
}

async function writeBrowserUseMixedControlFields(
  socket: WebSocket,
  args: {
    readonly sessionId: string;
    readonly fields: readonly ResolvedBrowserUseUserActionField[];
    readonly commandId: number;
  },
  mutation: { writeStarted: boolean },
  signal: AbortSignal,
): Promise<void> {
  const [first, ...others] = args.fields;
  if (!first) {
    return;
  }
  const descriptor = (field: ResolvedBrowserUseUserActionField) => {
    return field.radio
      ? {
          kind: "radio",
          memberCount: field.radio.memberObjectIds.length,
          name: field.radio.name,
          options: field.radio.options,
          required: field.radio.siteRequired,
          selectedIndex: field.radio.selectedIndex,
          index: field.radioChoice?.memberIndex ?? null,
        }
      : field.inspection.inputType === "checkbox"
        ? {
            kind: "checkbox",
            checked: field.checkbox?.checked ?? null,
            observedChecked: field.inspection.checked,
            required: field.inspection.siteRequired,
          }
        : field.inspection.tagName === "SELECT"
          ? {
              kind: "select",
              mode: field.inspection.inputType,
              required: field.inspection.siteRequired,
              options: field.inspection.options,
              indices: field.selection?.optionIndexes ?? null,
            }
          : {
              kind: "scalar",
              tagName: field.inspection.tagName,
              inputType: field.inspection.inputType,
              required: field.inspection.siteRequired,
              multiple: field.inspection.multiple,
              minLength: field.inspection.minLength,
              maxLength: field.inspection.maxLength,
              pattern: field.inspection.pattern,
              min: field.inspection.min,
              max: field.inspection.max,
              step: field.inspection.step,
              value: field.value ?? null,
            };
  };
  const firstSpec = descriptor(first);
  const writerArguments = [
    { value: firstSpec },
    { value: others.length },
    ...others.flatMap((field) => {
      return [{ objectId: field.objectId }, { value: descriptor(field) }];
    }),
    ...args.fields.flatMap((field) => {
      if (!field.radio) {
        return [];
      }
      return [
        ...field.radio.memberObjectIds.map((objectId) => {
          return { objectId };
        }),
        field.radio.formOwnerObjectId
          ? { objectId: field.radio.formOwnerObjectId }
          : { value: null },
      ];
    }),
  ];
  const params = {
    objectId: first.objectId,
    functionDeclaration: browserUseMixedControlWriterFunction(),
    arguments: writerArguments,
    returnByValue: true,
  };
  mutation.writeStarted = true;
  const result = browserUseCdpValueSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: args.commandId,
        method: "Runtime.callFunctionOn",
        params,
        sessionId: args.sessionId,
      },
      signal,
    ),
    { reportInput: true },
  );
  if (result.result.value !== true) {
    throw new BrowserUseUserActionMutationError(true);
  }
  if (needsIndependentBrowserUseVerification(args.fields)) {
    // A separate CDP task observes microtasks queued by the website's event handlers.
    const verified = browserUseCdpValueSchema.parse(
      await sendBrowserUseCdpCommand(
        socket,
        {
          id: args.commandId + 1,
          method: "Runtime.callFunctionOn",
          params: {
            ...params,
            arguments: [
              { value: { ...firstSpec, verifyOnly: true } },
              ...writerArguments.slice(1),
            ],
          },
          sessionId: args.sessionId,
        },
        signal,
      ),
      { reportInput: true },
    );
    if (verified.result.value !== true) {
      throw new BrowserUseUserActionMutationError(true);
    }
  }
}

async function resolveBrowserUseFileControl(
  socket: WebSocket,
  target: BrowserUseUserActionExactTarget,
  field: BrowserUseUserActionApplyField,
  signal: AbortSignal,
  observePhase?: BrowserUseCdpPhaseObserver,
): Promise<{
  readonly page: AttachedBrowserUsePage;
  readonly objectId: string;
  readonly observed: BrowserUseControlInspection;
} | null> {
  const page = await openBrowserUseApplyPage(
    socket,
    target,
    signal,
    observePhase,
  );
  if (!page) {
    return null;
  }
  return await observeBrowserUseCdpPhase(
    "controls",
    signal,
    observePhase,
    async () => {
      const world = z
        .object({ executionContextId: z.number().int().positive() })
        .parse(
          await sendBrowserUseCdpCommand(
            socket,
            {
              id: 4,
              method: "Page.createIsolatedWorld",
              params: {
                frameId: page.frameId,
                worldName: "okou-native-file-input",
                grantUniveralAccess: false,
              },
              sessionId: page.sessionId,
            },
            signal,
          ),
        );
      const remoteResult = await settle(
        sendBrowserUseCdpCommand(
          socket,
          {
            id: 5,
            method: "DOM.resolveNode",
            params: {
              backendNodeId: field.backendNodeId,
              executionContextId: world.executionContextId,
            },
            sessionId: page.sessionId,
          },
          signal,
        ),
      );
      if (!remoteResult.ok) {
        if (isMissingBrowserUseNode(remoteResult.error)) {
          return null;
        }
        throw remoteResult.error;
      }
      const remote = browserUseCdpRemoteObjectSchema.safeParse(
        remoteResult.value,
      );
      if (!remote.success) {
        throw new Error("Browser Use CDP node resolution failed");
      }
      const objectId = remote.data.object.objectId;
      const [observed] = await inspectBrowserUseControls(
        socket,
        page.sessionId,
        [objectId],
        6,
        signal,
      );
      if (
        !observed ||
        !observed.writable ||
        !observed.connected ||
        !observed.mainDocument ||
        observed.tagName !== "INPUT" ||
        observed.inputType !== "file" ||
        !observed.fileSetFingerprint ||
        !observed.files
      ) {
        return null;
      }
      return { page, objectId, observed };
    },
  );
}

function assessBrowserUseFileChoice(
  field: BrowserUseUserActionApplyField,
  observed: BrowserUseControlInspection,
): "succeeded" | "stale" | "invalid" | "write" {
  const choice = field.fileChoice;
  if (choice && choice.observedFingerprint !== observed.fileSetFingerprint) {
    return "stale";
  }
  if (!choice || choice.operation === "keep") {
    return (field.required || observed.siteRequired) &&
      observed.files?.length === 0
      ? "invalid"
      : "succeeded";
  }
  if (
    choice.operation === "clear" &&
    (field.required || observed.siteRequired)
  ) {
    return "invalid";
  }
  if (
    choice.operation === "replace" &&
    (!choice.files.length || (!observed.multiple && choice.files.length > 1))
  ) {
    return "invalid";
  }
  return "write";
}

async function applyBrowserUseFileActionOnSocket(
  socket: WebSocket,
  target: BrowserUseUserActionExactTarget,
  mutation: { writeStarted: boolean },
  signal: AbortSignal,
  observePhase?: BrowserUseCdpPhaseObserver,
): Promise<"succeeded" | "stale" | "invalid"> {
  const field = target.fields[0];
  if (
    !field ||
    target.fields.length !== 1 ||
    field.fingerprint.tagName !== "INPUT" ||
    field.fingerprint.inputType !== "file"
  ) {
    return "invalid";
  }
  const resolved = await resolveBrowserUseFileControl(
    socket,
    target,
    field,
    signal,
    observePhase,
  );
  if (!resolved) {
    return "stale";
  }
  const { page, objectId, observed } = resolved;
  const decision = assessBrowserUseFileChoice(field, observed);
  if (decision !== "write") {
    return decision;
  }
  const choice = field.fileChoice;
  if (!choice) {
    return "invalid";
  }
  const expected = choice.files.map(({ name, type, size }) => {
    return {
      name,
      size,
      type,
    };
  });
  const snapshot = {
    accept: observed.accept,
    multiple: observed.multiple,
    required: observed.siteRequired,
    files: observed.files,
  };
  const writer = `function (original, operation, files) {
    if (!(this instanceof HTMLInputElement) || this.type !== "file" ||
      !this.isConnected || this.ownerDocument !== document || this.matches(":disabled") ||
      this.webkitdirectory ||
      this.accept !== original.accept || this.multiple !== original.multiple ||
      this.required !== original.required ||
      JSON.stringify([...this.files].map(f => ({ name: f.name, size: f.size, type: f.type }))) !==
        JSON.stringify(original.files)) return false;
    const transfer = new DataTransfer();
    if (operation === "replace") for (const item of files) {
      const raw = atob(item.contentBase64);
      const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
      transfer.items.add(new File([bytes], item.name, { type: item.type }));
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
    if (!setter) return false;
    setter.call(this, transfer.files);
    this.dispatchEvent(new Event("input", { bubbles: true }));
    this.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }`;
  mutation.writeStarted = true;
  const wrote = browserUseCdpValueSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: 7,
        method: "Runtime.callFunctionOn",
        sessionId: page.sessionId,
        params: {
          objectId,
          functionDeclaration: writer,
          arguments: [
            { value: snapshot },
            { value: choice.operation },
            { value: choice.files },
          ],
          returnByValue: true,
        },
      },
      signal,
    ),
  );
  if (wrote.result.value !== true) {
    throw new BrowserUseUserActionMutationError(true);
  }
  const verified = browserUseCdpValueSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: 8,
        method: "Runtime.callFunctionOn",
        sessionId: page.sessionId,
        params: {
          objectId,
          functionDeclaration: `function (original, expected) {
      return this instanceof HTMLInputElement && this.type === "file" &&
        this.isConnected && this.ownerDocument === document && !this.matches(":disabled") &&
        !this.webkitdirectory &&
        this.accept === original.accept && this.multiple === original.multiple &&
        this.required === original.required &&
        JSON.stringify([...this.files].map(f => ({ name: f.name, size: f.size, type: f.type }))) ===
          JSON.stringify(expected);
    }`,
          arguments: [{ value: snapshot }, { value: expected }],
          returnByValue: true,
        },
      },
      signal,
    ),
  );
  if (verified.result.value !== true) {
    throw new BrowserUseUserActionMutationError(true);
  }
  return "succeeded";
}

async function applyBrowserUseUserActionOnSocket(
  socket: WebSocket,
  target: BrowserUseUserActionExactTarget,
  mutation: { writeStarted: boolean },
  signal: AbortSignal,
  observePhase: BrowserUseCdpPhaseObserver,
): Promise<"succeeded" | "stale" | "invalid"> {
  if (
    target.fields.some((field) => {
      return field.fingerprint.inputType === "file";
    })
  ) {
    return await applyBrowserUseFileActionOnSocket(
      socket,
      target,
      mutation,
      signal,
      observePhase,
    );
  }
  const attached = await openBrowserUseApplyPage(
    socket,
    target,
    signal,
    observePhase,
  );
  if (!attached) {
    return "stale";
  }
  const resolved = await observeBrowserUseCdpPhase(
    "controls",
    signal,
    observePhase,
    async () => {
      return await resolveBrowserUseApplyFields(
        socket,
        attached.sessionId,
        target.fields,
        signal,
      );
    },
  );
  if (!resolved) {
    return "stale";
  }
  const valid = await observeBrowserUseCdpPhase(
    "validation",
    signal,
    observePhase,
    async () => {
      return await validateBrowserUseApplyValues(
        socket,
        {
          sessionId: attached.sessionId,
          fields: resolved.fields,
          commandId: resolved.commandId,
        },
        signal,
      );
    },
  );
  if (!valid) {
    return "invalid";
  }
  const writeArgs = {
    sessionId: attached.sessionId,
    fields: resolved.fields,
    commandId: resolved.commandId + (resolved.fields.length > 0 ? 1 : 0),
  };
  if (
    resolved.fields.some((field) => {
      return (
        field.inspection.tagName === "SELECT" ||
        field.inspection.inputType === "checkbox" ||
        field.inspection.inputType === "radio" ||
        (resolved.fields.some((candidate) => {
          return candidate.value !== undefined;
        }) &&
          ["date", "time", "datetime-local", "month", "week"].includes(
            field.inspection.inputType,
          ))
      );
    })
  ) {
    await writeBrowserUseMixedControlFields(
      socket,
      writeArgs,
      mutation,
      signal,
    );
  } else {
    await writeBrowserUseApplyFields(socket, writeArgs, mutation, signal);
  }
  return "succeeded";
}

export async function applyBrowserUseUserAction(
  cdpUrl: string,
  target: BrowserUseUserActionExactTarget,
  signal: AbortSignal,
  attemptId: string,
): Promise<"succeeded" | "stale" | "invalid"> {
  const mutation = { writeStarted: false };
  const cdpSignal = browserUseCdpSignal(signal);
  const observePhase = nativeInputCdpPhaseObserver("apply", attemptId);
  const operation = await settleIncludingAbort(
    withBrowserUseCdpSocket(
      cdpUrl,
      cdpSignal,
      async (socket) => {
        return await applyBrowserUseUserActionOnSocket(
          socket,
          target,
          mutation,
          cdpSignal,
          observePhase,
        );
      },
      observePhase,
    ),
  );
  if (!operation.ok) {
    L.warn("Browser input apply CDP failed", {
      type: "browser_input_apply_failure",
      attemptId,
      writeStarted:
        operation.error instanceof BrowserUseUserActionMutationError
          ? operation.error.writeStarted
          : mutation.writeStarted,
    });
    if (operation.error instanceof BrowserUseUserActionMutationError) {
      throw operation.error;
    }
    throw new BrowserUseUserActionMutationError(mutation.writeStarted);
  }
  return operation.value;
}

function disposableBrowserUseTabUrl(url: string): boolean {
  return url === "about:blank" || url === "chrome://newtab/";
}

export async function restoreBrowserUseTabUrls(
  cdpUrl: string,
  urls: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  if (urls.length === 0) {
    return;
  }
  const boundedUrls = boundedRestorableBrowserUseTabUrls(urls);
  if (boundedUrls.length === 0) {
    return;
  }
  const cdpSignal = browserUseCdpSignal(signal);
  await withBrowserUseCdpSocket(cdpUrl, cdpSignal, async (socket) => {
    const targets = browserUseCdpTargetsSchema.parse(
      await sendBrowserUseCdpCommand(
        socket,
        { id: 1, method: "Target.getTargets", params: {} },
        cdpSignal,
      ),
      { reportInput: true },
    );
    let commandId = 2;
    let restored = 0;
    for (const url of boundedUrls) {
      const result = await settle(
        sendBrowserUseCdpCommand(
          socket,
          { id: commandId, method: "Target.createTarget", params: { url } },
          cdpSignal,
        ),
      );
      commandId += 1;
      signal.throwIfAborted();
      if (result.ok) {
        restored += 1;
      }
    }
    if (restored === 0) {
      throw new Error("Browser Use CDP did not restore any tab");
    }
    for (const target of targets.targetInfos) {
      if (target.type !== "page" || !disposableBrowserUseTabUrl(target.url)) {
        continue;
      }
      await settle(
        sendBrowserUseCdpCommand(
          socket,
          {
            id: commandId,
            method: "Target.closeTarget",
            params: { targetId: target.targetId },
          },
          cdpSignal,
        ),
      );
      commandId += 1;
      signal.throwIfAborted();
    }
  });
}

export async function resizeBrowserUseSession(
  cdpUrl: string,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<void> {
  const result = await settle(
    resizeBrowserUseCdp(cdpUrl, width, height, browserUseCdpSignal(signal)),
  );
  signal.throwIfAborted();
  if (!result.ok) {
    throw new BrowserUseProviderError(
      502,
      "BROWSER_USE_RESIZE_ERROR",
      "Managed browser provider could not resize the browser",
    );
  }
}

function boundedProviderMessage(message: string): string {
  const normalized = Array.from(message, (character) => {
    const codeUnit = character.charCodeAt(0);
    return codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)
      ? " "
      : character;
  }).join("");
  return normalized.length <= MAX_BROWSER_USE_ERROR_MESSAGE_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_BROWSER_USE_ERROR_MESSAGE_CHARS - 3)}...`;
}

function providerMessage(body: unknown): string {
  if (typeof body === "string" && body.trim()) {
    return boundedProviderMessage(body);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Browser Use request failed";
  }
  for (const key of ["detail", "message", "error"] as const) {
    const value = Reflect.get(body, key);
    if (typeof value === "string" && value.trim()) {
      return boundedProviderMessage(value);
    }
  }
  return "Browser Use request failed";
}

function providerError(response: Response, body: unknown) {
  const message = providerMessage(body);
  if (response.status === 401 || response.status === 403) {
    return new BrowserUseProviderError(
      503,
      "BROWSER_USE_AUTH_ERROR",
      "Managed browser provider authentication failed",
    );
  }
  if (response.status === 402 || response.status === 429) {
    return new BrowserUseProviderError(
      503,
      "BROWSER_USE_CAPACITY",
      "Managed browser capacity is temporarily unavailable",
    );
  }
  return new BrowserUseProviderError(
    502,
    "BROWSER_USE_ERROR",
    `Managed browser provider failed: ${message}`,
  );
}

async function browserUseRequest(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
  acceptedStatuses: readonly number[] = [],
): Promise<unknown> {
  const apiKey = env("OKOU_BROWSER_USE_API_KEY");
  if (!apiKey) {
    throw new BrowserUseProviderError(
      503,
      "BROWSER_USE_NOT_CONFIGURED",
      "Managed browser provider is not configured",
    );
  }

  const result = await settle(
    (async (): Promise<{ response: Response; body: unknown }> => {
      const response = await fetch(`${BROWSER_USE_API_BASE_URL}${path}`, {
        ...init,
        headers: {
          "X-Browser-Use-API-Key": apiKey,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(BROWSER_USE_REQUEST_TIMEOUT_MS),
        ]),
      });
      const text = await readBoundedResponseText(
        response,
        MAX_BROWSER_USE_RESPONSE_BYTES,
      );
      if (text.kind === "too_large") {
        throw new BrowserUseProviderError(
          502,
          "BROWSER_USE_OUTPUT_TOO_LARGE",
          "Managed browser provider response is too large",
        );
      }
      const body = text.text
        ? (safeJsonParse(text.text) ?? text.text)
        : undefined;
      return { response, body };
    })(),
  );

  if (!result.ok) {
    signal.throwIfAborted();
    if (result.error instanceof BrowserUseProviderError) {
      throw result.error;
    }
    throw new BrowserUseProviderError(
      502,
      "BROWSER_USE_TIMEOUT",
      "Managed browser provider request timed out",
    );
  }

  if (
    !result.value.response.ok &&
    !acceptedStatuses.includes(result.value.response.status)
  ) {
    throw providerError(result.value.response, result.value.body);
  }
  return result.value.body;
}

export async function createBrowserUseProfile(
  chatThreadId: string,
  signal: AbortSignal,
): Promise<string> {
  const body = await browserUseRequest(
    "/profiles",
    {
      method: "POST",
      body: JSON.stringify({
        name: `okou-browser-profile-${chatThreadId}`,
      }),
    },
    signal,
  );
  return browserUseProfileSchema.parse(body).id;
}

export async function deleteBrowserUseProfile(
  profileId: string,
  signal: AbortSignal,
): Promise<void> {
  await browserUseRequest(
    `/profiles/${encodeURIComponent(profileId)}`,
    { method: "DELETE" },
    signal,
    [404],
  );
}

export async function createBrowserUseSession(
  args: {
    readonly profileId: string;
    readonly proxyCountryCode: string | null;
    readonly timeoutMinutes: number;
  },
  signal: AbortSignal,
): Promise<BrowserUseSession> {
  const body = await browserUseRequest(
    "/browsers",
    {
      method: "POST",
      body: JSON.stringify({
        profileId: args.profileId,
        proxyCountryCode: args.proxyCountryCode,
        timeout: args.timeoutMinutes,
        browserScreenWidth: BROWSER_SCREEN_WIDTH,
        browserScreenHeight: BROWSER_INITIAL_SCREEN_HEIGHT,
        allowResizing: true,
        enableRecording: false,
      }),
    },
    signal,
  );
  return parseBrowserUseSession(body);
}

export async function getBrowserUseSession(
  providerSessionId: string,
  signal: AbortSignal,
): Promise<BrowserUseSession> {
  const body = await browserUseRequest(
    `/browsers/${encodeURIComponent(providerSessionId)}`,
    { method: "GET" },
    signal,
  );
  return parseBrowserUseSession(body);
}

export async function stopBrowserUseSession(
  providerSessionId: string,
  signal: AbortSignal,
): Promise<BrowserUseSession> {
  const body = await browserUseRequest(
    `/browsers/${encodeURIComponent(providerSessionId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ action: "stop" }),
    },
    signal,
  );
  return parseBrowserUseSession(body);
}

export async function stopBrowserUseSessionForCleanup(
  providerSessionId: string,
  signal: AbortSignal,
): Promise<void> {
  await browserUseRequest(
    `/browsers/${encodeURIComponent(providerSessionId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ action: "stop" }),
    },
    signal,
    [404],
  );
}
