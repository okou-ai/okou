import { spawnSync } from "node:child_process";

import {
  array,
  boolean,
  literal,
  number,
  object,
  string,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import {
  BrowserInputRequestError,
  withBrowserInputFieldPosition,
} from "./browser-input-request-error";
import {
  BrowserCdpClient as CdpClient,
  CDP_COMMAND_TIMEOUT_MS,
} from "./browser-cdp";

const AGENT_BROWSER_TIMEOUT_MS = 15_000;
const AGENT_BROWSER_MAX_OUTPUT_BYTES = 256 * 1024;
const BROWSER_CAPTURE_TIMEOUT_MS = 30_000;
const CDP_CLEANUP_TIMEOUT_MS = 1_000;
const MAX_PAGE_TARGETS = 50;

const SET_PAGE_MARKER_SCRIPT =
  '(()=>{const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,"0")).join("");const key="__okou_browser_user_action_page_"+random();const value=random();Object.defineProperty(globalThis,key,{value,configurable:true,enumerable:false});return {key,value}})()';
const SET_FIELD_MARKER_SCRIPT =
  '(()=>{const element=document.activeElement;if(!element||element===document.body||element===document.documentElement)return null;const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,"0")).join("");const key="__okou_browser_user_action_field_"+random();const value=random();Object.defineProperty(element,key,{value,configurable:true,enumerable:false});return {key,value}})()';
const SET_VERIFY_MARKER_SCRIPT =
  '(()=>{const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,"0")).join("");const key="__okou_browser_user_action_verify_"+random();const value=random();Object.defineProperty(globalThis,key,{value,configurable:true,enumerable:false});return {key,value}})()';
const DELETE_PAGE_MARKER_SCRIPT =
  '(()=>{for(const key of Object.getOwnPropertyNames(globalThis)){if(key.startsWith("__okou_browser_user_action_page_"))delete globalThis[key]}return true})()';

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

const agentBrowserResponseSchema = object({
  success: boolean(),
  data: zUnknown().optional(),
}).passthrough();

const agentBrowserCdpResponseSchema = object({
  success: literal(true),
  data: object({ cdpUrl: string().min(1) }).passthrough(),
}).passthrough();

const agentBrowserMarkerResponseSchema = object({
  success: literal(true),
  data: object({
    result: object({
      key: string().regex(
        /^__okou_browser_user_action_(?:page|field|verify)_[0-9a-f]{32}$/u,
      ),
      value: string().regex(/^[0-9a-f]{32}$/u),
    }).strict(),
  }).passthrough(),
}).passthrough();

const cdpTargetsSchema = object({
  targetInfos: array(
    object({
      targetId: string().min(1),
      type: string(),
      url: string(),
    }).passthrough(),
  ),
});

const cdpAttachedTargetSchema = object({
  sessionId: string().min(1),
});

const cdpEvaluationSchema = object({
  result: object({
    type: string(),
    subtype: string().optional(),
    objectId: string().min(1).optional(),
    value: zUnknown().optional(),
  }).passthrough(),
  exceptionDetails: zUnknown().optional(),
}).passthrough();

const cdpNodeSchema = object({
  node: object({
    backendNodeId: number().int().positive().safe(),
    nodeName: string(),
  }).passthrough(),
});

interface AttachedPage {
  readonly targetId: string;
  readonly sessionId: string;
  readonly globalObjectId: string;
}

interface Marker {
  readonly key: string;
  readonly value: string;
}

type MarkerKind = "page" | "field" | "verify";

function browserCaptureError(
  message: string,
  code = "BROWSER_INPUT_CAPTURE_FAILED",
  nextAction = "Inspect the current Browser page and retry the request.",
  retryable = false,
): BrowserInputRequestError {
  return new BrowserInputRequestError(code, message, nextAction, retryable);
}

function browserConnectionError(message: string): BrowserInputRequestError {
  return browserCaptureError(
    message,
    "BROWSER_INPUT_BROWSER_CONNECTION_FAILED",
    "Run `okou browser use` to reconnect this Browser, then retry.",
  );
}

function browserTimeoutError(message: string): BrowserInputRequestError {
  return browserCaptureError(
    message,
    "BROWSER_INPUT_CAPTURE_TIMEOUT",
    "Check the Browser connection, then retry the request.",
    true,
  );
}

function boundedTimeout(maximumMs: number, deadline?: number): number {
  if (deadline === undefined) {
    return maximumMs;
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw browserTimeoutError("Browser input capture timed out");
  }
  return Math.max(1, Math.min(maximumMs, remainingMs));
}

function parseAgentBrowserOutput(
  output: string,
): zInfer<typeof agentBrowserResponseSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw browserConnectionError(
      "agent-browser returned an unreadable response",
    );
  }
  const response = agentBrowserResponseSchema.safeParse(parsed);
  if (!response.success || !response.data.success) {
    throw browserConnectionError(
      "agent-browser could not inspect the requested Browser target",
    );
  }
  return response.data;
}

function runAgentBrowser(
  sessionName: string,
  args: readonly string[],
  deadline?: number,
): zInfer<typeof agentBrowserResponseSchema> {
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
  if (
    result.error &&
    "code" in result.error &&
    result.error.code === "ETIMEDOUT"
  ) {
    throw browserTimeoutError("agent-browser inspection timed out");
  }
  if (result.error || result.status !== 0) {
    if (!result.error && args[0] === "focus") {
      throw browserCaptureError(
        "the Browser element reference could not be focused",
        "BROWSER_INPUT_TARGET_UNAVAILABLE",
        "Take a new agent-browser snapshot and choose a current control reference.",
      );
    }
    throw browserConnectionError(
      "agent-browser could not inspect the requested Browser target",
    );
  }
  return parseAgentBrowserOutput(result.stdout);
}

function tryAgentBrowser(
  sessionName: string,
  args: readonly string[],
  deadline: number,
): void {
  try {
    runAgentBrowser(sessionName, args, deadline);
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
    throw browserConnectionError(
      "agent-browser did not expose a compatible CDP connection",
    );
  }
  let url: URL;
  try {
    url = new URL(response.data.data.cdpUrl);
  } catch {
    throw browserConnectionError(
      "agent-browser did not expose a compatible CDP connection",
    );
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw browserConnectionError(
      "agent-browser did not expose a compatible CDP connection",
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
  const response = agentBrowserMarkerResponseSchema.safeParse(
    runAgentBrowser(sessionName, ["eval", definition.script], deadline),
  );
  if (!response.success) {
    throw browserCaptureError(
      "agent-browser could not mark the requested Browser target",
    );
  }
  return response.data.data.result;
}

function markerDefinition(kind: MarkerKind): {
  readonly script: string;
} {
  switch (kind) {
    case "page":
      return { script: SET_PAGE_MARKER_SCRIPT };
    case "field":
      return { script: SET_FIELD_MARKER_SCRIPT };
    case "verify":
      return { script: SET_VERIFY_MARKER_SCRIPT };
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
  const available = attached.flatMap((result) => {
    return result.status === "fulfilled" ? [result.value] : [];
  });
  if (available.length === 0) {
    const connectionFailure = attached.find((result) => {
      return (
        result.status === "rejected" &&
        result.reason instanceof BrowserInputRequestError &&
        (result.reason.code === "BROWSER_INPUT_CAPTURE_TIMEOUT" ||
          result.reason.code === "BROWSER_INPUT_BROWSER_CONNECTION_FAILED")
      );
    });
    if (connectionFailure?.status === "rejected") {
      throw connectionFailure.reason;
    }
  }
  return available;
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
  } catch (error) {
    if (error instanceof BrowserInputRequestError) {
      throw error;
    }
    return false;
  }
}

async function findMarkedPage(
  client: CdpClient,
  pages: readonly AttachedPage[],
  marker: Marker,
): Promise<AttachedPage> {
  const inspected = await Promise.allSettled(
    pages.map(async (page) => {
      return { page, matches: await pageHasMarker(client, page, marker) };
    }),
  );
  const matches = inspected.flatMap((result) => {
    return result.status === "fulfilled" && result.value.matches
      ? [result.value.page]
      : [];
  });
  if (matches.length === 1) {
    // The unique marker identifies this page even if another tab was unresponsive.
    return matches[0]!;
  }
  if (matches.length === 0) {
    const failure = inspected.find((result) => {
      return result.status === "rejected";
    });
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  }
  throw browserCaptureError(
    "The active Browser page changed or could not be identified; retry the request",
    "BROWSER_INPUT_PAGE_CHANGED",
    "Inspect the active Browser tab again and recapture its controls.",
  );
}

async function evaluatedObjectId(
  client: CdpClient,
  page: AttachedPage,
  functionDeclaration: string,
  args: readonly unknown[],
): Promise<string> {
  let evaluation: zInfer<typeof cdpEvaluationSchema>;
  try {
    evaluation = cdpEvaluationSchema.parse(
      await callPageFunction(client, page, functionDeclaration, args, false),
    );
  } catch (error) {
    if (error instanceof BrowserInputRequestError) {
      throw error;
    }
    throw browserCaptureError(
      "A requested Browser field target is invalid or unavailable",
      "BROWSER_INPUT_TARGET_UNAVAILABLE",
      "Inspect the page and choose one exact supported control.",
    );
  }
  if (
    evaluation.exceptionDetails !== undefined ||
    evaluation.result.subtype !== "node" ||
    !evaluation.result.objectId
  ) {
    const matchCount = evaluation.result.value;
    if (typeof matchCount === "number" && Number.isSafeInteger(matchCount)) {
      throw browserCaptureError(
        matchCount === 0
          ? "the target matched no controls"
          : `the target matched ${matchCount} controls`,
        matchCount === 0
          ? "BROWSER_INPUT_TARGET_MISSING"
          : "BROWSER_INPUT_TARGET_AMBIGUOUS",
        "Inspect the page and choose one exact supported control.",
      );
    }
    throw browserCaptureError(
      "the target is missing or ambiguous",
      "BROWSER_INPUT_TARGET_UNAVAILABLE",
      "Inspect the page and choose one exact supported control.",
    );
  }
  return evaluation.result.objectId;
}

async function describeInputNode(
  client: CdpClient,
  page: AttachedPage,
  objectId: string,
): Promise<number> {
  let described: zInfer<typeof cdpNodeSchema>;
  try {
    described = cdpNodeSchema.parse(
      await client.send("DOM.describeNode", { objectId }, page.sessionId),
    );
  } catch (error) {
    if (error instanceof BrowserInputRequestError) {
      throw error;
    }
    throw browserCaptureError(
      "A requested Browser field target changed during capture",
      "BROWSER_INPUT_TARGET_CHANGED",
      "Inspect the current page and recapture this control.",
    );
  }
  if (
    described.node.nodeName !== "INPUT" &&
    described.node.nodeName !== "TEXTAREA" &&
    described.node.nodeName !== "SELECT"
  ) {
    throw browserCaptureError(
      "Browser input requests support only top-level input, textarea, and select controls",
      "BROWSER_INPUT_UNSUPPORTED_CONTROL",
      "Choose a top-level input, textarea, or select, or hand the Browser to the user.",
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
      {
        connection: browserConnectionError,
        timeout: browserTimeoutError,
        command: () => {
          return browserCaptureError(
            "The Browser target changed during capture",
          );
        },
      },
    );
    pages = await attachPages(client);
    const page = await findMarkedPage(client, pages, pageMarker);
    const backendNodeIds: number[] = [];
    for (const [index, target] of targets.entries()) {
      try {
        backendNodeIds.push(
          isRef(target)
            ? await captureRef(
                client,
                page,
                pages,
                sessionName,
                target,
                deadline,
              )
            : await captureSelector(client, page, target),
        );
      } catch (error) {
        throw withBrowserInputFieldPosition(error, index + 1);
      }
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
          "BROWSER_INPUT_PAGE_CHANGED",
          "Inspect the active Browser tab again and recapture its controls.",
        );
      }
    } finally {
      await cleanupMarker(client, pages, finalMarker);
    }
    const firstPosition = new Map<number, number>();
    for (const [index, backendNodeId] of backendNodeIds.entries()) {
      const previous = firstPosition.get(backendNodeId);
      if (previous !== undefined) {
        throw browserCaptureError(
          `--field ${index + 1} targets the same control as --field ${previous}`,
          "BROWSER_INPUT_DUPLICATE_TARGET",
          "Choose a different control for one of these fields.",
        );
      }
      firstPosition.set(backendNodeId, index + 1);
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
      tryAgentBrowser(
        sessionName,
        ["eval", DELETE_PAGE_MARKER_SCRIPT],
        deadline,
      );
    }
  }
}
