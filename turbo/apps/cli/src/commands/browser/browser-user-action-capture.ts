import { randomUUID } from "node:crypto";
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
}

interface Marker {
  readonly key: string;
  readonly value: string;
}

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

function definePropertyExpression(
  owner: "globalThis" | "document.activeElement",
  marker: Marker,
): string {
  const key = JSON.stringify(marker.key);
  const value = JSON.stringify(marker.value);
  if (owner === "document.activeElement") {
    return `(()=>{const element=document.activeElement;if(!element||element===document.body||element===document.documentElement)return false;return Object.defineProperty(element,${key},{value:${value},configurable:true,enumerable:false}),true})()`;
  }
  return `(()=>{Object.defineProperty(globalThis,${key},{value:${value},configurable:true,enumerable:false});return true})()`;
}

function deleteGlobalPropertyExpression(marker: Marker): string {
  return `delete globalThis[${JSON.stringify(marker.key)}]`;
}

function markerExpression(marker: Marker): string {
  return `globalThis[${JSON.stringify(marker.key)}]===${JSON.stringify(marker.value)}`;
}

function markedActiveElementExpression(marker: Marker): string {
  return `(()=>{const element=document.activeElement;return element&&element[${JSON.stringify(marker.key)}]===${JSON.stringify(marker.value)}?element:null})()`;
}

function selectorExpression(target: string): string {
  if (target.startsWith("xpath=")) {
    const xpath = JSON.stringify(target.slice("xpath=".length));
    return `(()=>{const result=document.evaluate(${xpath},document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);return result.snapshotLength===1?result.snapshotItem(0):result.snapshotLength})()`;
  }
  const selector = JSON.stringify(target);
  return `(()=>{const result=document.querySelectorAll(${selector});return result.length===1?result[0]:result.length})()`;
}

function newMarker(prefix: string): Marker {
  return {
    key: `__okou_${prefix}_${randomUUID().replaceAll("-", "")}`,
    value: randomUUID(),
  };
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
      return { targetId: target.targetId, sessionId: parsed.data.sessionId };
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
      await client.send(
        "Runtime.evaluate",
        { expression: markerExpression(marker), returnByValue: true },
        page.sessionId,
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
  expression: string,
): Promise<string> {
  let evaluation: z.infer<typeof cdpEvaluationSchema>;
  try {
    evaluation = cdpEvaluationSchema.parse(
      await client.send(
        "Runtime.evaluate",
        { expression, returnByValue: false },
        page.sessionId,
      ),
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
      await client.send(
        "Runtime.evaluate",
        {
          expression: `(()=>{delete globalThis[${JSON.stringify(marker.key)}];const element=document.activeElement;if(element)delete element[${JSON.stringify(marker.key)}]})()`,
          returnByValue: true,
        },
        page.sessionId,
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
        functionDeclaration: "function(key){return delete this[key]}",
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
  const marker = newMarker("field");
  let objectId: string | null = null;
  try {
    runAgentBrowser(sessionName, ["focus", normalizeRef(target)], deadline);
    runAgentBrowser(
      sessionName,
      ["eval", definePropertyExpression("document.activeElement", marker)],
      deadline,
    );
    objectId = await evaluatedObjectId(
      client,
      page,
      markedActiveElementExpression(marker),
    );
    return await describeInputNode(client, page, objectId);
  } finally {
    if (objectId) {
      await cleanupObjectMarker(client, page, objectId, marker);
    }
    await cleanupMarker(client, pages, marker);
  }
}

async function captureSelector(
  client: CdpClient,
  page: AttachedPage,
  target: string,
): Promise<number> {
  const objectId = await evaluatedObjectId(
    client,
    page,
    selectorExpression(target),
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
  const pageMarker = newMarker("page");
  let client: CdpClient | null = null;
  let pages: readonly AttachedPage[] = [];
  try {
    runAgentBrowser(
      sessionName,
      ["eval", definePropertyExpression("globalThis", pageMarker)],
      deadline,
    );
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
    const finalMarker = newMarker("verify");
    try {
      runAgentBrowser(
        sessionName,
        ["eval", definePropertyExpression("globalThis", finalMarker)],
        deadline,
      );
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
      await cleanupMarker(client, pages, pageMarker);
      await detachPages(client, pages);
      client.close();
    }
    tryAgentBrowser(sessionName, [
      "eval",
      deleteGlobalPropertyExpression(pageMarker),
    ]);
  }
}
