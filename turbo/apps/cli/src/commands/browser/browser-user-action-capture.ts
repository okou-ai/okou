import { spawnSync } from "node:child_process";

import { z } from "zod";

const AGENT_BROWSER_TIMEOUT_MS = 15_000;
const AGENT_BROWSER_MAX_OUTPUT_BYTES = 256 * 1024;
const BROWSER_CAPTURE_TIMEOUT_MS = 30_000;
const CDP_CONNECT_TIMEOUT_MS = 5_000;
const CDP_COMMAND_TIMEOUT_MS = 5_000;
const CDP_CLEANUP_TIMEOUT_MS = 1_000;
const CDP_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_PAGE_TARGETS = 50;
const PAGE_MARKER_KEY = "__okou_browser_user_action_page_marker";
const FIELD_MARKER_KEY = "__okou_browser_user_action_field_marker";
const VERIFY_MARKER_KEY = "__okou_browser_user_action_verify_marker";

const SET_PAGE_MARKER_SCRIPT =
  '(()=>{const value=Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,"0")).join("");Object.defineProperty(globalThis,"__okou_browser_user_action_page_marker",{value,configurable:true,enumerable:false});return value})()';
const SET_FIELD_MARKER_SCRIPT =
  '(()=>{const element=document.activeElement;if(!element||element===document.body||element===document.documentElement)return null;const value=Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,"0")).join("");Object.defineProperty(element,"__okou_browser_user_action_field_marker",{value,configurable:true,enumerable:false});return value})()';
const SET_VERIFY_MARKER_SCRIPT =
  '(()=>{const value=Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,"0")).join("");Object.defineProperty(globalThis,"__okou_browser_user_action_verify_marker",{value,configurable:true,enumerable:false});return value})()';
const DELETE_PAGE_MARKER_SCRIPT =
  'delete globalThis["__okou_browser_user_action_page_marker"]';

const GLOBAL_OBJECT_EXPRESSION = "globalThis";
const HAS_MARKER_FUNCTION = "function(key,value){return this[key]===value}";
const MARKED_ACTIVE_ELEMENT_FUNCTION =
  "function(key,value){const element=document.activeElement;return element&&element[key]===value?element:null}";
const QUERY_SELECTOR_FUNCTION =
  "function(selector){const result=document.querySelectorAll(selector);return result.length===1?result[0]:result.length}";
const QUERY_XPATH_FUNCTION =
  "function(xpath){const result=document.evaluate(xpath,document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);return result.snapshotLength===1?result.snapshotItem(0):result.snapshotLength}";
const DELETE_MARKER_FUNCTION =
  "function(key){delete this[key];const element=document.activeElement;if(element)delete element[key]}";
const DELETE_OBJECT_MARKER_FUNCTION = "function(key){return delete this[key]}";

const agentBrowserResponseSchema = z
  .object({
    success: z.boolean(),
    data: z.unknown().optional(),
  })
  .passthrough();

const agentBrowserCdpResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ cdpUrl: z.string().min(1) }).passthrough(),
  })
  .passthrough();

const agentBrowserEvalStringResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ result: z.string().min(1) }).passthrough(),
  })
  .passthrough();

const cdpResponseSchema = z
  .object({
    id: z.number().int().positive(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

const cdpTargetsSchema = z.object({
  targetInfos: z.array(
    z
      .object({
        targetId: z.string().min(1),
        type: z.string(),
        url: z.string(),
      })
      .passthrough(),
  ),
});

const cdpAttachedTargetSchema = z.object({
  sessionId: z.string().min(1),
});

const cdpEvaluationSchema = z
  .object({
    result: z
      .object({
        type: z.string(),
        subtype: z.string().optional(),
        objectId: z.string().min(1).optional(),
        value: z.unknown().optional(),
      })
      .passthrough(),
    exceptionDetails: z.unknown().optional(),
  })
  .passthrough();

const cdpNodeSchema = z.object({
  node: z
    .object({
      backendNodeId: z.number().int().positive().safe(),
      nodeName: z.string(),
    })
    .passthrough(),
});

interface PendingCommand {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface AttachedPage {
  readonly targetId: string;
  readonly sessionId: string;
  readonly globalObjectId: string;
}

interface Marker {
  readonly key:
    | typeof PAGE_MARKER_KEY
    | typeof FIELD_MARKER_KEY
    | typeof VERIFY_MARKER_KEY;
  readonly value: string;
}

type MarkerKind = "page" | "field" | "verify";

function browserCaptureError(message: string): Error {
  return new Error(message);
}

function boundedTimeout(maximumMs: number, deadline?: number): number {
  if (deadline === undefined) {
    return maximumMs;
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw browserCaptureError("Browser input capture timed out");
  }
  return Math.max(1, Math.min(maximumMs, remainingMs));
}

function parseAgentBrowserOutput(
  output: string,
): z.infer<typeof agentBrowserResponseSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw browserCaptureError(
      "agent-browser returned an unreadable response; run `okou browser use` and retry",
    );
  }
  const response = agentBrowserResponseSchema.safeParse(parsed);
  if (!response.success || !response.data.success) {
    throw browserCaptureError(
      "agent-browser could not inspect the requested Browser target",
    );
  }
  return response.data;
}

function runAgentBrowser(
  sessionName: string,
  args: readonly string[],
  deadline?: number,
): z.infer<typeof agentBrowserResponseSchema> {
  const result = spawnSync(
    "agent-browser",
    ["--session", sessionName, "--json", ...args],
    {
      encoding: "utf8",
      maxBuffer: AGENT_BROWSER_MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: boundedTimeout(AGENT_BROWSER_TIMEOUT_MS, deadline),
    },
  );
  if (result.error || result.status !== 0) {
    throw browserCaptureError(
      "agent-browser could not inspect the requested Browser target; run `okou browser use` and retry",
    );
  }
  return parseAgentBrowserOutput(result.stdout);
}

function tryAgentBrowser(sessionName: string, args: readonly string[]): void {
  try {
    runAgentBrowser(sessionName, args);
  } catch {
    // Cleanup is best-effort. Markers are random, non-secret, and scoped to
    // the current document, so navigation also releases them.
  }
}

function agentBrowserCdpUrl(sessionName: string, deadline: number): string {
  const response = agentBrowserCdpResponseSchema.safeParse(
    runAgentBrowser(sessionName, ["get", "cdp-url"], deadline),
  );
  if (!response.success) {
    throw browserCaptureError(
      "agent-browser did not expose a compatible CDP connection; run `okou browser use` and retry",
    );
  }
  let url: URL;
  try {
    url = new URL(response.data.data.cdpUrl);
  } catch {
    throw browserCaptureError(
      "agent-browser did not expose a compatible CDP connection; run `okou browser use` and retry",
    );
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw browserCaptureError(
      "agent-browser did not expose a compatible CDP connection; run `okou browser use` and retry",
    );
  }
  return url.toString();
}

function createAgentBrowserMarker(
  sessionName: string,
  kind: MarkerKind,
  deadline: number,
): Marker {
  const definition = markerDefinition(kind);
  const response = agentBrowserEvalStringResponseSchema.safeParse(
    runAgentBrowser(sessionName, ["eval", definition.script], deadline),
  );
  if (!response.success) {
    throw browserCaptureError(
      "agent-browser could not mark the requested Browser target",
    );
  }
  return { key: definition.key, value: response.data.data.result };
}

function markerDefinition(kind: MarkerKind): {
  readonly key: Marker["key"];
  readonly script: string;
} {
  switch (kind) {
    case "page":
      return { key: PAGE_MARKER_KEY, script: SET_PAGE_MARKER_SCRIPT };
    case "field":
      return { key: FIELD_MARKER_KEY, script: SET_FIELD_MARKER_SCRIPT };
    case "verify":
      return { key: VERIFY_MARKER_KEY, script: SET_VERIFY_MARKER_SCRIPT };
  }
}

function isHttpPage(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function closeWebSocket(socket: WebSocket, code?: number): void {
  if (
    socket.readyState !== WebSocket.CONNECTING &&
    socket.readyState !== WebSocket.OPEN
  ) {
    return;
  }
  try {
    socket.close(code);
  } catch {
    // Closing a failed connection is best-effort; the command still rejects.
  }
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private failed = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly deadline: number,
  ) {
    socket.addEventListener("message", (event) => {
      this.handleMessage(event);
    });
    socket.addEventListener("error", () => {
      this.failAll();
    });
    socket.addEventListener("close", () => {
      this.failAll();
    });
  }

  static async connect(url: string, deadline: number): Promise<CdpClient> {
    const connectTimeoutMs = boundedTimeout(CDP_CONNECT_TIMEOUT_MS, deadline);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      throw browserCaptureError("Could not connect to the attached Browser");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        closeWebSocket(socket);
        reject(
          browserCaptureError("The Browser inspection connection timed out"),
        );
      }, connectTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onFailure);
        socket.removeEventListener("close", onFailure);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onFailure = () => {
        cleanup();
        closeWebSocket(socket);
        reject(
          browserCaptureError("Could not connect to the attached Browser"),
        );
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onFailure);
      socket.addEventListener("close", onFailure);
    });
    return new CdpClient(socket, deadline);
  }

  private handleMessage(event: MessageEvent): void {
    if (
      typeof event.data !== "string" ||
      event.data.length > CDP_MAX_RESPONSE_BYTES
    ) {
      this.failAll();
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      this.failAll();
      return;
    }
    const response = cdpResponseSchema.safeParse(raw);
    if (!response.success) {
      return;
    }
    const pending = this.pending.get(response.data.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.data.id);
    if (response.data.error !== undefined) {
      pending.reject(
        browserCaptureError("The Browser target changed during capture"),
      );
      return;
    }
    pending.resolve(response.data.result);
  }

  private failAll(): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        browserCaptureError("The Browser inspection connection closed"),
      );
    }
    this.pending.clear();
  }

  async send(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    sessionId?: string,
    timeoutMs = CDP_COMMAND_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.failed || this.socket.readyState !== WebSocket.OPEN) {
      throw browserCaptureError("The Browser inspection connection is closed");
    }
    const id = this.nextId;
    this.nextId += 1;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(browserCaptureError("The Browser target did not respond"));
        },
        boundedTimeout(timeoutMs, this.deadline),
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(browserCaptureError("Could not inspect the Browser target"));
      }
    });
  }

  close(): void {
    this.failAll();
    closeWebSocket(this.socket, 1000);
  }
}

async function callPageFunction(
  client: CdpClient,
  page: AttachedPage,
  functionDeclaration: string,
  args: readonly unknown[],
  returnByValue: boolean,
  timeoutMs = CDP_COMMAND_TIMEOUT_MS,
): Promise<unknown> {
  return await client.send(
    "Runtime.callFunctionOn",
    {
      objectId: page.globalObjectId,
      functionDeclaration,
      arguments: args.map((value) => {
        return { value };
      }),
      returnByValue,
    },
    page.sessionId,
    timeoutMs,
  );
}

async function attachPages(
  client: CdpClient,
): Promise<readonly AttachedPage[]> {
  const targetResult = cdpTargetsSchema.safeParse(
    await client.send("Target.getTargets"),
  );
  if (!targetResult.success) {
    throw browserCaptureError(
      "The attached Browser returned incompatible page information",
    );
  }
  const targets = targetResult.data.targetInfos.filter((target) => {
    return target.type === "page" && isHttpPage(target.url);
  });
  if (targets.length === 0 || targets.length > MAX_PAGE_TARGETS) {
    throw browserCaptureError(
      "The attached Browser has no bounded HTTP page to capture",
    );
  }
  const attached = await Promise.allSettled(
    targets.map(async (target): Promise<AttachedPage> => {
      const parsed = cdpAttachedTargetSchema.safeParse(
        await client.send("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: true,
        }),
      );
      if (!parsed.success) {
        throw browserCaptureError("Could not attach to a Browser page");
      }
      const sessionId = parsed.data.sessionId;
      try {
        const globalObject = cdpEvaluationSchema.parse(
          await client.send(
            "Runtime.evaluate",
            { expression: GLOBAL_OBJECT_EXPRESSION, returnByValue: false },
            sessionId,
          ),
        );
        if (
          globalObject.exceptionDetails !== undefined ||
          !globalObject.result.objectId
        ) {
          throw browserCaptureError("Could not inspect a Browser page");
        }
        return {
          targetId: target.targetId,
          sessionId,
          globalObjectId: globalObject.result.objectId,
        };
      } catch (error) {
        try {
          await client.send(
            "Target.detachFromTarget",
            { sessionId },
            undefined,
            CDP_CLEANUP_TIMEOUT_MS,
          );
        } catch {
          // Preserve the page-inspection failure; this detach is best-effort.
        }
        throw error;
      }
    }),
  );
  return attached.flatMap((result) => {
    return result.status === "fulfilled" ? [result.value] : [];
  });
}

async function pageHasMarker(
  client: CdpClient,
  page: AttachedPage,
  marker: Marker,
): Promise<boolean> {
  try {
    const evaluation = cdpEvaluationSchema.parse(
      await callPageFunction(
        client,
        page,
        HAS_MARKER_FUNCTION,
        [marker.key, marker.value],
        true,
      ),
    );
    return (
      evaluation.exceptionDetails === undefined &&
      evaluation.result.value === true
    );
  } catch {
    return false;
  }
}

async function findMarkedPage(
  client: CdpClient,
  pages: readonly AttachedPage[],
  marker: Marker,
): Promise<AttachedPage> {
  const matches = (
    await Promise.all(
      pages.map(async (page) => {
        return (await pageHasMarker(client, page, marker)) ? page : null;
      }),
    )
  ).filter((page): page is AttachedPage => {
    return page !== null;
  });
  if (matches.length !== 1) {
    throw browserCaptureError(
      "The active Browser page changed or could not be identified; retry the request",
    );
  }
  return matches[0]!;
}

async function evaluatedObjectId(
  client: CdpClient,
  page: AttachedPage,
  functionDeclaration: string,
  args: readonly unknown[],
): Promise<string> {
  let evaluation: z.infer<typeof cdpEvaluationSchema>;
  try {
    evaluation = cdpEvaluationSchema.parse(
      await callPageFunction(client, page, functionDeclaration, args, false),
    );
  } catch {
    throw browserCaptureError(
      "A requested Browser field target is invalid or unavailable",
    );
  }
  if (
    evaluation.exceptionDetails !== undefined ||
    evaluation.result.subtype !== "node" ||
    !evaluation.result.objectId
  ) {
    throw browserCaptureError(
      "A requested Browser field target is missing or ambiguous",
    );
  }
  return evaluation.result.objectId;
}

async function describeInputNode(
  client: CdpClient,
  page: AttachedPage,
  objectId: string,
): Promise<number> {
  let described: z.infer<typeof cdpNodeSchema>;
  try {
    described = cdpNodeSchema.parse(
      await client.send("DOM.describeNode", { objectId }, page.sessionId),
    );
  } catch {
    throw browserCaptureError(
      "A requested Browser field target changed during capture",
    );
  }
  if (
    described.node.nodeName !== "INPUT" &&
    described.node.nodeName !== "TEXTAREA"
  ) {
    throw browserCaptureError(
      "Browser input requests support only top-level input and textarea controls",
    );
  }
  return described.node.backendNodeId;
}

async function cleanupMarker(
  client: CdpClient,
  pages: readonly AttachedPage[],
  marker: Marker,
): Promise<void> {
  await Promise.allSettled(
    pages.map(async (page) => {
      await callPageFunction(
        client,
        page,
        DELETE_MARKER_FUNCTION,
        [marker.key],
        true,
        CDP_CLEANUP_TIMEOUT_MS,
      );
    }),
  );
}

async function cleanupObjectMarker(
  client: CdpClient,
  page: AttachedPage,
  objectId: string,
  marker: Marker,
): Promise<void> {
  try {
    await client.send(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: DELETE_OBJECT_MARKER_FUNCTION,
        arguments: [{ value: marker.key }],
        returnByValue: true,
      },
      page.sessionId,
      CDP_CLEANUP_TIMEOUT_MS,
    );
  } catch {
    // The page-wide cleanup below remains the best-effort fallback when the
    // captured object is already detached or its document navigated.
  }
}

async function detachPages(
  client: CdpClient,
  pages: readonly AttachedPage[],
): Promise<void> {
  await Promise.allSettled(
    pages.map(async (page) => {
      await client.send(
        "Target.detachFromTarget",
        { sessionId: page.sessionId },
        undefined,
        CDP_CLEANUP_TIMEOUT_MS,
      );
    }),
  );
}

function isRef(target: string): boolean {
  return /^(?:@?e\d+|ref=e\d+)$/u.test(target);
}

function normalizeRef(target: string): string {
  if (target.startsWith("@")) {
    return target;
  }
  return target.startsWith("ref=")
    ? `@${target.slice("ref=".length)}`
    : `@${target}`;
}

async function captureRef(
  client: CdpClient,
  page: AttachedPage,
  pages: readonly AttachedPage[],
  sessionName: string,
  target: string,
  deadline: number,
): Promise<number> {
  let marker: Marker | null = null;
  let objectId: string | null = null;
  try {
    runAgentBrowser(sessionName, ["focus", normalizeRef(target)], deadline);
    marker = createAgentBrowserMarker(sessionName, "field", deadline);
    objectId = await evaluatedObjectId(
      client,
      page,
      MARKED_ACTIVE_ELEMENT_FUNCTION,
      [marker.key, marker.value],
    );
    return await describeInputNode(client, page, objectId);
  } finally {
    if (objectId && marker) {
      await cleanupObjectMarker(client, page, objectId, marker);
    }
    if (marker) {
      await cleanupMarker(client, pages, marker);
    }
  }
}

async function captureSelector(
  client: CdpClient,
  page: AttachedPage,
  target: string,
): Promise<number> {
  const isXpath = target.startsWith("xpath=");
  const objectId = await evaluatedObjectId(
    client,
    page,
    isXpath ? QUERY_XPATH_FUNCTION : QUERY_SELECTOR_FUNCTION,
    [isXpath ? target.slice("xpath=".length) : target],
  );
  return await describeInputNode(client, page, objectId);
}

export interface BrowserInputCapture {
  readonly pageTargetId: string;
  readonly backendNodeIds: readonly number[];
}

export async function captureBrowserInputTargets(
  sessionName: string,
  targets: readonly string[],
): Promise<BrowserInputCapture> {
  const deadline = Date.now() + BROWSER_CAPTURE_TIMEOUT_MS;
  let pageMarker: Marker | null = null;
  let client: CdpClient | null = null;
  let pages: readonly AttachedPage[] = [];
  try {
    pageMarker = createAgentBrowserMarker(sessionName, "page", deadline);
    client = await CdpClient.connect(
      agentBrowserCdpUrl(sessionName, deadline),
      deadline,
    );
    pages = await attachPages(client);
    const page = await findMarkedPage(client, pages, pageMarker);
    const backendNodeIds: number[] = [];
    for (const target of targets) {
      backendNodeIds.push(
        isRef(target)
          ? await captureRef(client, page, pages, sessionName, target, deadline)
          : await captureSelector(client, page, target),
      );
    }
    const finalMarker = createAgentBrowserMarker(
      sessionName,
      "verify",
      deadline,
    );
    try {
      if (
        !(await pageHasMarker(client, page, finalMarker)) ||
        !(await pageHasMarker(client, page, pageMarker))
      ) {
        throw browserCaptureError(
          "The active Browser page changed during capture; retry the request",
        );
      }
    } finally {
      await cleanupMarker(client, pages, finalMarker);
    }
    if (new Set(backendNodeIds).size !== backendNodeIds.length) {
      throw browserCaptureError(
        "Browser input request fields must target different controls",
      );
    }
    return { pageTargetId: page.targetId, backendNodeIds };
  } finally {
    if (client) {
      if (pageMarker) {
        await cleanupMarker(client, pages, pageMarker);
      }
      await detachPages(client, pages);
      client.close();
    }
    if (pageMarker) {
      tryAgentBrowser(sessionName, ["eval", DELETE_PAGE_MARKER_SCRIPT]);
    }
  }
}
