import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, zstdDecompress } from "node:zlib";

import {
  PI_API_FIRST_TURN_SESSION_MAX_BYTES,
  piDeferredHandoffDataSchema,
  piApiFirstTurnManifestSchema,
  type PiApiFirstTurnConfig,
  type PiApiFirstTurnManifest,
  type PiApiFirstTurnOwnershipTransferMode,
  type PiDeferredSandboxConfig,
} from "@okouai/api-contracts/contracts/runners";
import {
  inspectPiSessionJsonl,
  type PiSessionInspection,
} from "@okouai/pi-agent-runtime/api";

const MANIFEST_MAX_BYTES = 16 * 1024;
const INITIAL_POLL_DELAY_MS = 100;
const MAX_POLL_DELAY_MS = 500;
const DEFERRED_HANDOFF_MAX_BYTES = 32 * 1024 * 1024;
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

interface PiApiFirstTurnHandoff {
  readonly resourceSnapshot?: ReturnType<
    typeof piDeferredHandoffDataSchema.parse
  >["resourceSnapshot"];
  readonly sessionFile: string;
  readonly boundaryControl: PiApiFirstTurnBoundaryControl;
  readonly ownershipTransferMode: PiApiFirstTurnOwnershipTransferMode;
  readonly langfuseParent?: PiApiFirstTurnManifest["langfuseParent"];
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

async function restoreSession(args: {
  readonly config: PiApiFirstTurnConfig;
  readonly manifest: PiApiFirstTurnManifest;
  readonly runtime: HandoffRuntime;
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly mode: PiApiFirstTurnOwnershipTransferMode;
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
  validateSessionMode({
    inspection: session,
    manifest: args.manifest,
    mode: args.mode,
  });

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

/** Poll the wire coordination deadline and restore the validated checkpoint. */
export async function resolvePiApiFirstTurnHandoff(args: {
  readonly config: PiApiFirstTurnConfig | PiDeferredSandboxConfig;
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly deferredHandoffFile?: string;
  readonly runtime?: HandoffRuntime;
}): Promise<PiApiFirstTurnHandoff> {
  const runtime = args.runtime ?? defaultRuntime;
  if (args.config.schemaVersion === 2) {
    return restoreDeferredSandboxHandoff({
      ...args,
      config: args.config,
      runtime,
    });
  }
  const manifest = await pollManifest(args.config, runtime);
  const boundaryControl: PiApiFirstTurnBoundaryControl = {
    schemaVersion: 2,
    sandboxEventSequenceStart: manifest.sandboxEventSequenceStart,
    ownershipTransferMode: manifest.mode,
  };
  return {
    boundaryControl,
    ownershipTransferMode: manifest.mode,
    ...(manifest.langfuseParent
      ? { langfuseParent: manifest.langfuseParent }
      : {}),
    sessionFile: await restoreSession({
      config: args.config,
      manifest,
      runtime,
      sessionDir: args.sessionDir,
      sessionId: args.sessionId,
      mode: manifest.mode,
    }),
  };
}

async function readDeferredHandoffData(path: string | undefined) {
  if (!path) {
    throw new Error("Deferred Pi requires its authenticated handoff file");
  }
  const file = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > DEFERRED_HANDOFF_MAX_BYTES
    ) {
      throw new Error("Pi durable handoff file bounds mismatch");
    }
    const bytes = await file.readFile();
    if (
      bytes.length !== stat.size ||
      bytes.length > DEFERRED_HANDOFF_MAX_BYTES
    ) {
      throw new Error("Pi durable handoff file changed while being read");
    }
    return piDeferredHandoffDataSchema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
  } finally {
    await file.close();
  }
}

/** The durable payload has already won Runner claim. Validate its exact native
 * checkpoint before RPC startup; no polling or first-provider replay. */
async function restoreDeferredSandboxHandoff(args: {
  readonly config: PiDeferredSandboxConfig;
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly deferredHandoffFile?: string;
  readonly runtime: HandoffRuntime;
}): Promise<PiApiFirstTurnHandoff> {
  const { config } = args;
  const data = await readDeferredHandoffData(args.deferredHandoffFile);
  const bytes = Buffer.from(data.sessionHistory, "utf8");
  if (
    bytes.length > PI_API_FIRST_TURN_SESSION_MAX_BYTES ||
    createHash("sha256").update(bytes).digest("hex") !== config.historyHash ||
    createHash("sha256")
      .update(JSON.stringify(data.resourceSnapshot))
      .digest("hex") !== config.resourceSnapshotDigest ||
    args.runtime.now() >= config.deadlineAt
  ) {
    throw new Error(
      "Pi durable handoff failed its integrity or deadline check",
    );
  }
  const inspection = inspectPiSessionJsonl(data.sessionHistory);
  if (
    inspection.sessionId !== args.sessionId ||
    config.baseSession.sessionId !== args.sessionId
  ) {
    throw new Error("Pi durable handoff session identity mismatch");
  }
  const mode =
    config.continuation.mode === "pending-tools"
      ? "pending-tool-continuation"
      : config.continuation.mode === "settled-session"
        ? "settled-session-continuation"
        : "sandbox-first";
  if (
    config.continuation.mode === "pending-tools" &&
    JSON.stringify(inspection.pendingToolIds) !==
      JSON.stringify(config.continuation.pendingToolIds)
  ) {
    throw new Error("Pi durable handoff pending tool identities mismatch");
  }
  if (
    config.continuation.mode !== "untouched-h0" &&
    config.sandboxEventSequenceStart !==
      config.continuation.lastEventSequence + 1
  ) {
    throw new Error("Pi durable handoff event sequence mismatch");
  }
  validateSessionMode({
    inspection,
    mode,
    manifest: {
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode,
      baseSession: config.baseSession,
      session: {
        sessionId: args.sessionId,
        sha256: config.historyHash,
        rawSize: bytes.length,
      },
      sandboxEventSequenceStart: config.sandboxEventSequenceStart,
    },
  });
  const sessionFile = join(
    args.sessionDir,
    `deferred-${config.ownerEpoch}-${config.generation}-${args.sessionId}.jsonl`,
  );
  const temporaryFile = `${sessionFile}.${randomUUID()}.tmp`;
  await mkdir(args.sessionDir, { recursive: true });
  await writeFile(temporaryFile, bytes, { mode: 0o600 });
  await rename(temporaryFile, sessionFile);
  return {
    sessionFile,
    resourceSnapshot: data.resourceSnapshot,
    ownershipTransferMode: mode,
    boundaryControl: {
      schemaVersion: 2,
      sandboxEventSequenceStart: config.sandboxEventSequenceStart,
      ownershipTransferMode: mode,
    },
  };
}
