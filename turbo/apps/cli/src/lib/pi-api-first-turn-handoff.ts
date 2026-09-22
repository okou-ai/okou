import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, zstdDecompress } from "node:zlib";

import {
  PI_API_FIRST_TURN_SESSION_MAX_BYTES,
  piApiFirstTurnManifestSchema,
  type PiApiFirstTurnConfig,
  type PiApiFirstTurnManifest,
  type PiApiFirstTurnOwnershipTransferMode,
} from "@okouai/api-contracts/contracts/runners";
import type { PiApiHandoffUsage } from "@okouai/api-contracts/contracts/pi-inference-lifecycle";
import { PI_AGENT_RUNTIME_VERSION } from "@okouai/pi-agent-runtime";
import {
  inspectPiSessionJsonl,
  type PiSessionInspection,
} from "@okouai/pi-agent-runtime/api";

const MANIFEST_MAX_BYTES = 16 * 1024;
const INITIAL_POLL_DELAY_MS = 100;
const MAX_POLL_DELAY_MS = 500;
const gunzipHistory = promisify(gunzip);
const unzstdHistory = promisify(zstdDecompress);

type PiApiFirstTurnHandoffErrorCode =
  | "PI_HANDOFF_BASE_SESSION_MISMATCH"
  | "PI_HANDOFF_H1_DOWNLOAD_FAILED"
  | "PI_HANDOFF_H1_HASH_MISMATCH"
  | "PI_HANDOFF_H1_INVALID"
  | "PI_HANDOFF_H1_LATE"
  | "PI_HANDOFF_H1_TOO_LARGE"
  | "PI_HANDOFF_H1_WRITE_FAILED"
  | "PI_HANDOFF_MANIFEST_INVALID"
  | "PI_HANDOFF_MANIFEST_TIMEOUT"
  | "PI_HANDOFF_SESSION_MISMATCH";

class PiApiFirstTurnHandoffError extends Error {
  readonly code: PiApiFirstTurnHandoffErrorCode;

  constructor(
    code: PiApiFirstTurnHandoffErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`[${code}] ${message}`, options);
    this.name = "PiApiFirstTurnHandoffError";
    this.code = code;
  }
}

export interface PiApiFirstTurnBoundaryControl {
  readonly schemaVersion: 2;
  readonly sandboxEventSequenceStart: number;
  readonly ownershipTransferMode: PiApiFirstTurnOwnershipTransferMode;
}

/**
 * The sandbox restarted the turn from H0 instead of continuing the API's H1.
 *
 * Recorded so the discarded API-side attempt stays explainable; `apiUsage`
 * still carries what the API consumed.
 */
interface PiApiFirstTurnHandoffDegrade {
  readonly reason: "runtime_parity_mismatch";
  readonly requiredPiAgentRuntimeVersion: string;
  readonly installedPiAgentRuntimeVersion: string;
}

interface PiApiFirstTurnHandoff {
  readonly sessionFile: string;
  readonly boundaryControl: PiApiFirstTurnBoundaryControl;
  readonly ownershipTransferMode: PiApiFirstTurnOwnershipTransferMode;
  readonly langfuseParent?: PiApiFirstTurnManifest["langfuseParent"];
  readonly apiUsage?: PiApiHandoffUsage;
  readonly degraded?: PiApiFirstTurnHandoffDegrade;
}

export interface HandoffRuntime {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

const defaultRuntime: HandoffRuntime = {
  fetch,
  now: Date.now,
  sleep(milliseconds) {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  },
};

async function responseBufferWithMaxBytes(args: {
  readonly response: Response;
  readonly maxBytes: number;
  readonly code: "PI_HANDOFF_H1_TOO_LARGE" | "PI_HANDOFF_MANIFEST_INVALID";
  readonly readErrorCode:
    | "PI_HANDOFF_H1_DOWNLOAD_FAILED"
    | "PI_HANDOFF_MANIFEST_INVALID";
  readonly label: string;
}): Promise<Buffer> {
  const declaredLengthHeader = args.response.headers.get("content-length");
  const declaredLength =
    declaredLengthHeader === null ? undefined : Number(declaredLengthHeader);
  if (
    declaredLength !== undefined &&
    Number.isFinite(declaredLength) &&
    declaredLength > args.maxBytes
  ) {
    startBodyCancellation(args.response.body);
    throw new PiApiFirstTurnHandoffError(
      args.code,
      `${args.label} exceeds its size limit`,
    );
  }
  if (!args.response.body) {
    return Buffer.alloc(0);
  }
  const reader = args.response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return Buffer.concat(chunks, size);
      }
      size += value.byteLength;
      if (size > args.maxBytes) {
        startReaderCancellation(reader);
        throw new PiApiFirstTurnHandoffError(
          args.code,
          `${args.label} exceeds its size limit`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof PiApiFirstTurnHandoffError) {
      throw error;
    }
    throw new PiApiFirstTurnHandoffError(
      args.readErrorCode,
      `${args.label} body could not be read`,
      { cause: error },
    );
  }
}

function startBodyCancellation(body: ReadableStream<Uint8Array> | null): void {
  if (body) {
    void body.cancel().then(
      () => {},
      () => {},
    );
  }
}

function startReaderCancellation(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  void reader.cancel().then(
    () => {},
    () => {},
  );
}

function manifestTimeout(cause?: unknown): PiApiFirstTurnHandoffError {
  return new PiApiFirstTurnHandoffError(
    "PI_HANDOFF_MANIFEST_TIMEOUT",
    "Pi API first-turn manifest did not arrive before the deadline",
    cause === undefined ? undefined : { cause },
  );
}

async function pollManifest(
  config: PiApiFirstTurnConfig,
  runtime: HandoffRuntime,
): Promise<PiApiFirstTurnManifest> {
  let delayMs = INITIAL_POLL_DELAY_MS;
  while (runtime.now() < config.deadlineAt) {
    const remainingMs = config.deadlineAt - runtime.now();
    let response: Response;
    try {
      response = await runtime.fetch(config.manifestUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(Math.max(1, remainingMs)),
      });
    } catch (error) {
      if (runtime.now() >= config.deadlineAt) {
        throw manifestTimeout(error);
      }
      await runtime.sleep(Math.min(delayMs, config.deadlineAt - runtime.now()));
      delayMs = Math.min(MAX_POLL_DELAY_MS, delayMs * 2);
      continue;
    }
    if (runtime.now() >= config.deadlineAt) {
      throw manifestTimeout();
    }
    if (response.ok) {
      const bytes = await responseBufferWithMaxBytes({
        response,
        maxBytes: MANIFEST_MAX_BYTES,
        code: "PI_HANDOFF_MANIFEST_INVALID",
        readErrorCode: "PI_HANDOFF_MANIFEST_INVALID",
        label: "Pi API first-turn manifest",
      });
      if (runtime.now() >= config.deadlineAt) {
        throw manifestTimeout();
      }
      try {
        return piApiFirstTurnManifestSchema.parse(
          JSON.parse(bytes.toString("utf8")) as unknown,
        );
      } catch (error) {
        throw new PiApiFirstTurnHandoffError(
          "PI_HANDOFF_MANIFEST_INVALID",
          "Pi API first-turn manifest is malformed or incompatible",
          { cause: error },
        );
      }
    }
    if (response.status !== 404 && response.status < 500) {
      throw new PiApiFirstTurnHandoffError(
        "PI_HANDOFF_MANIFEST_INVALID",
        `Pi API first-turn manifest returned ${response.status}`,
      );
    }
    const retryRemainingMs = config.deadlineAt - runtime.now();
    if (retryRemainingMs <= 0) {
      break;
    }
    await runtime.sleep(Math.min(delayMs, retryRemainingMs));
    delayMs = Math.min(MAX_POLL_DELAY_MS, delayMs * 2);
  }
  throw manifestTimeout();
}

function validateManifestIdentity(args: {
  readonly config: PiApiFirstTurnConfig;
  readonly manifest: PiApiFirstTurnManifest;
  readonly sessionId: string;
}): void {
  if (
    args.config.baseSession.sessionId !== args.sessionId ||
    args.manifest.session.sessionId !== args.sessionId ||
    (args.manifest.langfuseParent !== undefined &&
      args.manifest.langfuseParent.sessionId !== args.sessionId)
  ) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_SESSION_MISMATCH",
      "Pi API first-turn session id does not match the launch",
    );
  }
  if (
    args.manifest.baseSession.sessionId !== args.config.baseSession.sessionId ||
    args.manifest.baseSession.sha256 !== args.config.baseSession.sha256
  ) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_BASE_SESSION_MISMATCH",
      "Pi API first-turn manifest does not extend the configured H0",
    );
  }
}

function validateSessionMode(args: {
  readonly inspection: PiSessionInspection;
  readonly manifest: PiApiFirstTurnManifest;
  readonly mode: PiApiFirstTurnOwnershipTransferMode;
}): void {
  switch (args.mode) {
    case "sandbox-first": {
      const baseHash = args.manifest.baseSession.sha256;
      const isAuthoritativeH0 =
        baseHash === null
          ? args.inspection.messageCount === 0
          : args.manifest.session.sha256 === baseHash &&
            args.inspection.isSettledCheckpoint;
      if (!isAuthoritativeH0) {
        throw new PiApiFirstTurnHandoffError(
          "PI_HANDOFF_H1_INVALID",
          "Pi sandbox-first transfer does not contain the authoritative H0",
        );
      }
      return;
    }
    case "pending-tool-continuation": {
      if (!args.inspection.hasPendingToolCalls) {
        throw new PiApiFirstTurnHandoffError(
          "PI_HANDOFF_H1_INVALID",
          "Pi API first-turn H1 contains no pending Sandbox tool calls",
        );
      }
      return;
    }
    case "settled-session-continuation": {
      if (
        !args.inspection.isSettledCheckpoint ||
        args.inspection.messageCount === 0 ||
        args.manifest.session.sha256 === args.manifest.baseSession.sha256
      ) {
        throw new PiApiFirstTurnHandoffError(
          "PI_HANDOFF_H1_INVALID",
          "Pi settled-session transfer does not contain a completed API H1",
        );
      }
      return;
    }
  }
}

/**
 * Truncate an API-produced H1 back to the authoritative H0 it extends.
 *
 * H0 is a line-aligned prefix of H1 whose SHA-256 equals the configured base
 * checkpoint; a fresh session (null base) reduces to the session header line.
 */
export function deriveBaseSessionBytes(
  h1: Buffer,
  baseSessionSha256: string | null,
): Buffer {
  const firstLineEnd = h1.indexOf(0x0a);
  if (firstLineEnd === -1) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_INVALID",
      "Pi API first-turn H1 has no session header line",
    );
  }
  if (baseSessionSha256 === null) {
    return h1.subarray(0, firstLineEnd + 1);
  }
  const hash = createHash("sha256");
  let lineStart = 0;
  while (lineStart < h1.length) {
    const lineEnd = h1.indexOf(0x0a, lineStart);
    const prefixEnd = lineEnd === -1 ? h1.length : lineEnd + 1;
    hash.update(h1.subarray(lineStart, prefixEnd));
    if (hash.copy().digest("hex") === baseSessionSha256) {
      return h1.subarray(0, prefixEnd);
    }
    lineStart = prefixEnd;
  }
  throw new PiApiFirstTurnHandoffError(
    "PI_HANDOFF_BASE_SESSION_MISMATCH",
    "Pi API first-turn H1 does not extend the configured H0",
  );
}

/**
 * Whether a pending-tool handoff must restart from H0 because the API prepared
 * it with a different `pi-agent-runtime` build than the one running here.
 *
 * Only a pending-tool continuation depends on byte-level prompt and tool-schema
 * parity with the API. A settled H1 is a complete checkpoint, and resuming one
 * with a newer or older runtime is the ordinary cross-release resume path, so
 * it is never discarded.
 */
function runtimeParityDegrade(args: {
  readonly config: PiApiFirstTurnConfig;
  readonly manifest: PiApiFirstTurnManifest;
  readonly installedPiAgentRuntimeVersion: string;
}): PiApiFirstTurnHandoffDegrade | undefined {
  const required = args.config.requiredPiAgentRuntimeVersion;
  if (
    required === undefined ||
    args.manifest.mode !== "pending-tool-continuation" ||
    required === args.installedPiAgentRuntimeVersion
  ) {
    return undefined;
  }
  return {
    reason: "runtime_parity_mismatch",
    requiredPiAgentRuntimeVersion: required,
    installedPiAgentRuntimeVersion: args.installedPiAgentRuntimeVersion,
  };
}

function validateDegradedBaseSession(args: {
  readonly inspection: PiSessionInspection;
  readonly baseSessionSha256: string | null;
}): void {
  const isAuthoritativeH0 =
    args.baseSessionSha256 === null
      ? args.inspection.messageCount === 0
      : args.inspection.isSettledCheckpoint;
  if (!isAuthoritativeH0) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_INVALID",
      "Pi runtime-parity degrade could not recover the authoritative H0",
    );
  }
}

async function restoreSession(args: {
  readonly config: PiApiFirstTurnConfig;
  readonly manifest: PiApiFirstTurnManifest;
  readonly runtime: HandoffRuntime;
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly mode: PiApiFirstTurnOwnershipTransferMode;
  readonly degradeToBaseSession: boolean;
}): Promise<string> {
  validateManifestIdentity(args);
  let response: Response;
  try {
    response = await args.runtime.fetch(
      args.manifest.schemaVersion === 4
        ? args.manifest.history.url
        : args.config.sessionUrl,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(
          Math.max(1, args.config.deadlineAt - args.runtime.now()),
        ),
      },
    );
  } catch (error) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_DOWNLOAD_FAILED",
      "Pi API first-turn H1 download failed",
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_DOWNLOAD_FAILED",
      `Pi API first-turn H1 returned ${response.status}`,
    );
  }
  const encoded = await responseBufferWithMaxBytes({
    response,
    maxBytes:
      args.manifest.schemaVersion === 4
        ? args.manifest.history.encodedSize
        : PI_API_FIRST_TURN_SESSION_MAX_BYTES,
    code: "PI_HANDOFF_H1_TOO_LARGE",
    readErrorCode: "PI_HANDOFF_H1_DOWNLOAD_FAILED",
    label: "Pi API first-turn H1",
  });
  let bytes = encoded;
  if (args.manifest.schemaVersion === 4) {
    if (encoded.length !== args.manifest.history.encodedSize) {
      throw new PiApiFirstTurnHandoffError(
        "PI_HANDOFF_H1_HASH_MISMATCH",
        "Pi sandbox history encoded size does not match the manifest",
      );
    }
    try {
      switch (args.manifest.history.encoding) {
        case "identity": {
          break;
        }
        case "gzip": {
          bytes = await gunzipHistory(encoded, {
            maxOutputLength: args.manifest.session.rawSize,
          });
          break;
        }
        case "zstd": {
          bytes = await unzstdHistory(encoded, {
            maxOutputLength: args.manifest.session.rawSize,
          });
          break;
        }
      }
    } catch (error) {
      throw new PiApiFirstTurnHandoffError(
        "PI_HANDOFF_H1_INVALID",
        "Pi sandbox history could not be decoded within its size limit",
        { cause: error },
      );
    }
  }
  if (args.runtime.now() >= args.config.deadlineAt) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_LATE",
      "Pi API first-turn H1 arrived after the deadline",
    );
  }
  if (bytes.length !== args.manifest.session.rawSize) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_HASH_MISMATCH",
      "Pi API first-turn H1 size does not match the manifest",
    );
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== args.manifest.session.sha256) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_HASH_MISMATCH",
      "Pi API first-turn H1 hash does not match the manifest",
    );
  }
  if (args.degradeToBaseSession) {
    bytes = deriveBaseSessionBytes(bytes, args.manifest.baseSession.sha256);
  }

  let session: PiSessionInspection;
  try {
    const jsonl = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    session = inspectPiSessionJsonl(jsonl);
  } catch (error) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_INVALID",
      "Pi API first-turn H1 is not a supported native Pi session",
      { cause: error },
    );
  }
  if (session.sessionId !== args.sessionId) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_SESSION_MISMATCH",
      "Pi API first-turn H1 session id does not match the launch",
    );
  }
  if (args.degradeToBaseSession) {
    validateDegradedBaseSession({
      inspection: session,
      baseSessionSha256: args.manifest.baseSession.sha256,
    });
  } else {
    validateSessionMode({
      inspection: session,
      manifest: args.manifest,
      mode: args.mode,
    });
  }

  const sessionFile = join(
    args.sessionDir,
    `api-first-turn-${args.sessionId}.jsonl`,
  );
  const temporaryFile = `${sessionFile}.${randomUUID()}.tmp`;
  try {
    await mkdir(args.sessionDir, { recursive: true });
    await writeFile(temporaryFile, bytes, { mode: 0o600 });
    await rename(temporaryFile, sessionFile);
  } catch (error) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_WRITE_FAILED",
      "Pi API first-turn H1 could not be installed atomically",
      { cause: error },
    );
  }
  return sessionFile;
}

/**
 * Poll the wire coordination deadline and restore the validated checkpoint.
 *
 * A pending-tool handoff prepared by a different `pi-agent-runtime` build is
 * not continued: the sandbox restores H0 and reports `sandbox-first`, so the
 * guest delivers the prompt again and this runtime owns the whole turn. The
 * API's attempt is discarded, never executed on a mismatched runtime, and the
 * event sequence the API already consumed is preserved.
 */
export async function resolvePiApiFirstTurnHandoff(args: {
  readonly config: PiApiFirstTurnConfig;
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly runtime?: HandoffRuntime;
  /** Defaults to the runtime bundled into this CLI; tests inject a mismatch. */
  readonly installedPiAgentRuntimeVersion?: string;
}): Promise<PiApiFirstTurnHandoff> {
  const runtime = args.runtime ?? defaultRuntime;
  const manifest = await pollManifest(args.config, runtime);
  const degraded = runtimeParityDegrade({
    config: args.config,
    manifest,
    installedPiAgentRuntimeVersion:
      args.installedPiAgentRuntimeVersion ?? PI_AGENT_RUNTIME_VERSION,
  });
  const mode: PiApiFirstTurnOwnershipTransferMode = degraded
    ? "sandbox-first"
    : manifest.mode;
  const boundaryControl: PiApiFirstTurnBoundaryControl = {
    schemaVersion: 2,
    sandboxEventSequenceStart: manifest.sandboxEventSequenceStart,
    ownershipTransferMode: mode,
  };
  return {
    boundaryControl,
    ownershipTransferMode: mode,
    ...(manifest.langfuseParent
      ? { langfuseParent: manifest.langfuseParent }
      : {}),
    ...(manifest.apiUsage ? { apiUsage: manifest.apiUsage } : {}),
    ...(degraded ? { degraded } : {}),
    sessionFile: await restoreSession({
      config: args.config,
      manifest,
      runtime,
      sessionDir: args.sessionDir,
      sessionId: args.sessionId,
      mode,
      degradeToBaseSession: degraded !== undefined,
    }),
  };
}
