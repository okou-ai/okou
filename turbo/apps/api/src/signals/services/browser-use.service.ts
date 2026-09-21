import { createHash } from "node:crypto";
import { once } from "node:events";

import {
  BROWSER_INITIAL_SCREEN_HEIGHT,
  BROWSER_SCREEN_WIDTH,
} from "@okouai/api-contracts/contracts/browser";
import { z } from "zod";

import { env } from "../../lib/env";
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
const browserUseCdpDocumentSchema = z.object({
  root: z.object({ nodeId: z.number().int().positive() }),
});
const browserUseCdpNodeIdsSchema = z.object({
  nodeIds: z.array(z.number().int().positive()),
});
const browserUseCdpNodeSchema = z.object({
  node: z.object({ backendNodeId: z.number().int().positive() }),
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
  readonly tagName: "INPUT" | "TEXTAREA";
  readonly inputType: string;
}

export interface BrowserUseUserActionTarget {
  readonly backendNodeId: number;
  readonly fingerprint: BrowserUseUserActionFingerprint;
}

export interface BrowserUseUserActionCapture {
  readonly pageTargetId: string;
  readonly documentLoaderId: string;
  readonly pageUrl: string;
  readonly siteOrigin: string;
  readonly fields: readonly BrowserUseUserActionTarget[];
}

export type BrowserUseUserActionCaptureFailureCode =
  | "focused_page_not_found"
  | "focused_page_ambiguous"
  | "unsupported_page"
  | "invalid_selector"
  | "selector_not_found"
  | "selector_ambiguous"
  | "unsupported_control";

export class BrowserUseUserActionCaptureError extends Error {
  readonly code: BrowserUseUserActionCaptureFailureCode;

  constructor(code: BrowserUseUserActionCaptureFailureCode) {
    super(`Browser user-action capture failed: ${code}`);
    this.name = "BrowserUseUserActionCaptureError";
    this.code = code;
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
    throw sent.error;
  }
  while (true) {
    const received = await nextBrowserUseCdpSocketEvent(
      socket,
      ["message", "error", "close"],
      signal,
    );
    if (received.name !== "message") {
      throw new Error("Browser Use CDP connection closed");
    }
    if (!(received.event instanceof MessageEvent)) {
      continue;
    }
    if (
      typeof received.event.data !== "string" ||
      received.event.data.length >
        (maxResponseBytes ?? MAX_BROWSER_USE_CDP_RESPONSE_BYTES)
    ) {
      continue;
    }
    const response = browserUseCdpResponseSchema.safeParse(
      safeJsonParse(received.event.data),
    );
    if (!response.success || response.data.id !== id) {
      continue;
    }
    if (response.data.error) {
      throw new Error(response.data.error.message);
    }
    return response.data.result;
  }
}

async function withBrowserUseCdpSocket<T>(
  cdpUrl: string,
  signal: AbortSignal,
  operation: (socket: WebSocket) => Promise<T>,
): Promise<T> {
  const websocketUrl = await browserUseCdpWebSocketUrl(cdpUrl, signal);
  const socket = new WebSocket(websocketUrl);
  const result = await settle(
    (async () => {
      await waitForBrowserUseCdpSocket(socket, signal);
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

function safeControlInspection(value: unknown):
  | (BrowserUseUserActionFingerprint & {
      readonly connected: boolean;
      readonly mainDocument: boolean;
      readonly writable: boolean;
    })
  | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.tagName !== "INPUT" && candidate.tagName !== "TEXTAREA") ||
    typeof candidate.inputType !== "string" ||
    candidate.inputType.length > 64 ||
    typeof candidate.connected !== "boolean" ||
    typeof candidate.mainDocument !== "boolean" ||
    typeof candidate.writable !== "boolean"
  ) {
    return null;
  }
  return {
    tagName: candidate.tagName,
    inputType: candidate.inputType,
    connected: candidate.connected,
    mainDocument: candidate.mainDocument,
    writable: candidate.writable,
  };
}

function browserUseControlInspectionFunction(): string {
  return `function () {
    const input = this instanceof HTMLInputElement;
    const textarea = this instanceof HTMLTextAreaElement;
    const supportedInputTypes = new Set([
      "text", "password", "email", "tel", "url", "search", "number"
    ]);
    const supported = textarea || (input && supportedInputTypes.has(this.type));
    return {
      tagName: this.tagName,
      inputType: input ? this.type : textarea ? "textarea" : "",
      connected: this.isConnected,
      mainDocument: this.ownerDocument === document,
      writable: supported && !this.readOnly && !this.disabled,
    };
  }`;
}

async function inspectBrowserUseControl(
  socket: WebSocket,
  sessionId: string,
  backendNodeId: number,
  commandId: number,
  signal: AbortSignal,
): Promise<ReturnType<typeof safeControlInspection>> {
  const remote = browserUseCdpRemoteObjectSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: commandId,
        method: "DOM.resolveNode",
        params: { backendNodeId },
        sessionId,
      },
      signal,
    ),
    { reportInput: true },
  );
  const inspected = browserUseCdpValueSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: commandId + 1,
        method: "Runtime.callFunctionOn",
        params: {
          objectId: remote.object.objectId,
          functionDeclaration: browserUseControlInspectionFunction(),
          returnByValue: true,
        },
        sessionId,
      },
      signal,
    ),
    { reportInput: true },
  );
  return safeControlInspection(inspected.result.value);
}

async function findFocusedBrowserUsePage(
  socket: WebSocket,
  signal: AbortSignal,
): Promise<{
  readonly page: AttachedBrowserUsePage;
  readonly commandId: number;
}> {
  const targets = browserUseCdpTargetsSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      { id: 1, method: "Target.getTargets", params: {} },
      signal,
    ),
    { reportInput: true },
  );
  const pageTargets = targets.targetInfos.filter((target) => {
    return target.type === "page" && httpPageUrl(target.url) !== null;
  });
  let commandId = 2;
  const focusedPages: AttachedBrowserUsePage[] = [];
  for (const target of pageTargets) {
    const attached = await attachBrowserUsePage(
      socket,
      target,
      commandId,
      signal,
    );
    commandId += 1;
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
        signal,
      ),
      { reportInput: true },
    );
    commandId += 1;
    if (focus.result.value === true) {
      focusedPages.push(attached);
    }
  }
  if (focusedPages.length === 0) {
    throw new BrowserUseUserActionCaptureError("focused_page_not_found");
  }
  if (focusedPages.length !== 1) {
    throw new BrowserUseUserActionCaptureError("focused_page_ambiguous");
  }
  const page = focusedPages[0];
  if (!page) {
    throw new BrowserUseUserActionCaptureError("focused_page_not_found");
  }
  return { page, commandId };
}

async function captureBrowserUseControl(
  socket: WebSocket,
  args: {
    readonly sessionId: string;
    readonly rootNodeId: number;
    readonly selector: string;
    readonly commandId: number;
  },
  signal: AbortSignal,
): Promise<{
  readonly field: BrowserUseUserActionTarget;
  readonly commandId: number;
}> {
  const queried = await settle(
    sendBrowserUseCdpCommand(
      socket,
      {
        id: args.commandId,
        method: "DOM.querySelectorAll",
        params: { nodeId: args.rootNodeId, selector: args.selector },
        sessionId: args.sessionId,
      },
      signal,
    ),
  );
  if (!queried.ok) {
    throw new BrowserUseUserActionCaptureError("invalid_selector");
  }
  const nodeIds = browserUseCdpNodeIdsSchema.parse(queried.value, {
    reportInput: true,
  }).nodeIds;
  if (nodeIds.length === 0) {
    throw new BrowserUseUserActionCaptureError("selector_not_found");
  }
  if (nodeIds.length !== 1) {
    throw new BrowserUseUserActionCaptureError("selector_ambiguous");
  }
  const described = browserUseCdpNodeSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: args.commandId + 1,
        method: "DOM.describeNode",
        params: { nodeId: nodeIds[0] },
        sessionId: args.sessionId,
      },
      signal,
    ),
    { reportInput: true },
  );
  const inspected = await inspectBrowserUseControl(
    socket,
    args.sessionId,
    described.node.backendNodeId,
    args.commandId + 2,
    signal,
  );
  if (
    !inspected ||
    !inspected.connected ||
    !inspected.mainDocument ||
    !inspected.writable
  ) {
    throw new BrowserUseUserActionCaptureError("unsupported_control");
  }
  return {
    commandId: args.commandId + 4,
    field: {
      backendNodeId: described.node.backendNodeId,
      fingerprint: {
        tagName: inspected.tagName,
        inputType: inspected.inputType,
      },
    },
  };
}

async function captureBrowserUseUserActionOnSocket(
  socket: WebSocket,
  selectors: readonly string[],
  signal: AbortSignal,
): Promise<BrowserUseUserActionCapture> {
  const focused = await findFocusedBrowserUsePage(socket, signal);
  let commandId = focused.commandId;
  const frameTree = browserUseCdpFrameTreeSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: commandId,
        method: "Page.getFrameTree",
        params: {},
        sessionId: focused.page.sessionId,
      },
      signal,
    ),
    { reportInput: true },
  );
  commandId += 1;
  const pageUrl = httpPageUrl(frameTree.frameTree.frame.url);
  if (!pageUrl) {
    throw new BrowserUseUserActionCaptureError("unsupported_page");
  }
  const document = browserUseCdpDocumentSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: commandId,
        method: "DOM.getDocument",
        params: { depth: -1, pierce: false },
        sessionId: focused.page.sessionId,
      },
      signal,
    ),
    { reportInput: true },
  );
  commandId += 1;
  const fields: BrowserUseUserActionTarget[] = [];
  for (const selector of selectors) {
    const captured = await captureBrowserUseControl(
      socket,
      {
        sessionId: focused.page.sessionId,
        rootNodeId: document.root.nodeId,
        selector,
        commandId,
      },
      signal,
    );
    commandId = captured.commandId;
    fields.push(captured.field);
  }
  return {
    pageTargetId: focused.page.targetId,
    documentLoaderId: frameTree.frameTree.frame.loaderId,
    pageUrl: pageUrl.toString(),
    siteOrigin: pageUrl.origin,
    fields,
  };
}

/**
 * Resolve creation-time selectors once against the one focused top-level page.
 * The returned targets contain no selector or value data.
 */
export async function captureBrowserUseUserAction(
  cdpUrl: string,
  selectors: readonly string[],
  signal: AbortSignal,
): Promise<BrowserUseUserActionCapture> {
  const cdpSignal = browserUseCdpSignal(signal);
  return await withBrowserUseCdpSocket(cdpUrl, cdpSignal, async (socket) => {
    return await captureBrowserUseUserActionOnSocket(
      socket,
      selectors,
      cdpSignal,
    );
  });
}

export interface BrowserUseUserActionApplyField {
  readonly backendNodeId: number;
  readonly fingerprint: BrowserUseUserActionFingerprint;
  readonly value?: string;
}

interface BrowserUseUserActionApplyTarget {
  readonly pageTargetId: string;
  readonly documentLoaderId: string;
  readonly pageUrlHash: string;
  readonly fields: readonly BrowserUseUserActionApplyField[];
}

interface ResolvedBrowserUseUserActionField {
  readonly objectId: string;
  readonly value?: string;
}

async function openBrowserUseApplyPage(
  socket: WebSocket,
  target: BrowserUseUserActionApplyTarget,
  signal: AbortSignal,
): Promise<AttachedBrowserUsePage | null> {
  const targets = browserUseCdpTargetsSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      { id: 1, method: "Target.getTargets", params: {} },
      signal,
    ),
    { reportInput: true },
  );
  const targetInfo = targets.targetInfos.find((candidate) => {
    return (
      candidate.type === "page" && candidate.targetId === target.pageTargetId
    );
  });
  if (!targetInfo) {
    return null;
  }
  const attached = await attachBrowserUsePage(socket, targetInfo, 2, signal);
  const frameTree = browserUseCdpFrameTreeSchema.parse(
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
  const currentPageUrl = httpPageUrl(frameTree.frameTree.frame.url);
  if (
    frameTree.frameTree.frame.loaderId !== target.documentLoaderId ||
    !currentPageUrl ||
    createHash("sha256").update(currentPageUrl.toString()).digest("hex") !==
      target.pageUrlHash
  ) {
    return null;
  }
  return attached;
}

async function resolveBrowserUseApplyField(
  socket: WebSocket,
  args: {
    readonly sessionId: string;
    readonly field: BrowserUseUserActionApplyField;
    readonly commandId: number;
  },
  signal: AbortSignal,
): Promise<ResolvedBrowserUseUserActionField | null> {
  const remoteResult = await settle(
    sendBrowserUseCdpCommand(
      socket,
      {
        id: args.commandId,
        method: "DOM.resolveNode",
        params: { backendNodeId: args.field.backendNodeId },
        sessionId: args.sessionId,
      },
      signal,
    ),
  );
  if (!remoteResult.ok) {
    return null;
  }
  const remote = browserUseCdpRemoteObjectSchema.safeParse(remoteResult.value);
  if (!remote.success) {
    return null;
  }
  const inspectedResult = browserUseCdpValueSchema.parse(
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: args.commandId + 1,
        method: "Runtime.callFunctionOn",
        params: {
          objectId: remote.data.object.objectId,
          functionDeclaration: browserUseControlInspectionFunction(),
          returnByValue: true,
        },
        sessionId: args.sessionId,
      },
      signal,
    ),
    { reportInput: true },
  );
  const inspected = safeControlInspection(inspectedResult.result.value);
  if (
    !inspected ||
    !inspected.connected ||
    !inspected.mainDocument ||
    !inspected.writable ||
    inspected.tagName !== args.field.fingerprint.tagName ||
    inspected.inputType !== args.field.fingerprint.inputType
  ) {
    return null;
  }
  return {
    objectId: remote.data.object.objectId,
    ...(args.field.value === undefined ? {} : { value: args.field.value }),
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
  const resolved: ResolvedBrowserUseUserActionField[] = [];
  for (const field of fields) {
    const result = await resolveBrowserUseApplyField(
      socket,
      { sessionId, field, commandId },
      signal,
    );
    if (!result) {
      return null;
    }
    resolved.push(result);
    commandId += 2;
  }
  return { fields: resolved, commandId };
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
  let commandId = args.commandId;
  for (const field of args.fields) {
    if (field.value === undefined) {
      continue;
    }
    mutation.writeStarted = true;
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: commandId,
        method: "Runtime.callFunctionOn",
        params: {
          objectId: field.objectId,
          functionDeclaration: `function (nextValue) {
            const prototype = this instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
            if (!setter) throw new Error("native setter unavailable");
            setter.call(this, nextValue);
            this.dispatchEvent(new Event("input", { bubbles: true }));
            this.dispatchEvent(new Event("change", { bubbles: true }));
          }`,
          arguments: [{ value: field.value }],
          awaitPromise: false,
          returnByValue: true,
        },
        sessionId: args.sessionId,
      },
      signal,
    );
    commandId += 1;
  }
  for (const field of args.fields) {
    if (field.value === undefined) {
      continue;
    }
    const verified = browserUseCdpValueSchema.parse(
      await sendBrowserUseCdpCommand(
        socket,
        {
          id: commandId,
          method: "Runtime.callFunctionOn",
          params: {
            objectId: field.objectId,
            functionDeclaration:
              "function (expected) { return this.value === expected; }",
            arguments: [{ value: field.value }],
            returnByValue: true,
          },
          sessionId: args.sessionId,
        },
        signal,
      ),
      { reportInput: true },
    );
    commandId += 1;
    if (verified.result.value !== true) {
      throw new BrowserUseUserActionMutationError(true);
    }
  }
}

async function applyBrowserUseUserActionOnSocket(
  socket: WebSocket,
  target: BrowserUseUserActionApplyTarget,
  mutation: { writeStarted: boolean },
  signal: AbortSignal,
): Promise<"succeeded" | "stale"> {
  const attached = await openBrowserUseApplyPage(socket, target, signal);
  if (!attached) {
    return "stale";
  }
  const resolved = await resolveBrowserUseApplyFields(
    socket,
    attached.sessionId,
    target.fields,
    signal,
  );
  if (!resolved) {
    return "stale";
  }
  await writeBrowserUseApplyFields(
    socket,
    {
      sessionId: attached.sessionId,
      fields: resolved.fields,
      commandId: resolved.commandId,
    },
    mutation,
    signal,
  );
  return "succeeded";
}

export async function applyBrowserUseUserAction(
  cdpUrl: string,
  target: BrowserUseUserActionApplyTarget,
  signal: AbortSignal,
): Promise<"succeeded" | "stale"> {
  const mutation = { writeStarted: false };
  const cdpSignal = browserUseCdpSignal(signal);
  const operation = await settleIncludingAbort(
    withBrowserUseCdpSocket(cdpUrl, cdpSignal, async (socket) => {
      return await applyBrowserUseUserActionOnSocket(
        socket,
        target,
        mutation,
        cdpSignal,
      );
    }),
  );
  if (!operation.ok) {
    if (operation.error instanceof BrowserUseUserActionMutationError) {
      throw operation.error;
    }
    throw new BrowserUseUserActionMutationError(mutation.writeStarted);
  }
  return operation.value;
}

export async function activateBrowserUseUserActionTarget(
  cdpUrl: string,
  pageTargetId: string,
  signal: AbortSignal,
): Promise<"activated" | "stale"> {
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
    if (
      !targets.targetInfos.some((target) => {
        return target.type === "page" && target.targetId === pageTargetId;
      })
    ) {
      return "stale";
    }
    await sendBrowserUseCdpCommand(
      socket,
      {
        id: 2,
        method: "Target.activateTarget",
        params: { targetId: pageTargetId },
      },
      cdpSignal,
    );
    return "activated";
  });
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
