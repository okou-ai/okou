import { mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CANONICAL_PI_SESSION_DIR,
  PI_AGENT_DIR,
  PI_MEMORY_ROOT,
  piLaunchPayloadSchema,
  piModelConfigSchema,
  type PiLaunchPayload,
} from "@okouai/api-contracts/contracts/runners";
import { createPiSessionJsonl } from "@okouai/pi-agent-runtime/api";
import {
  PiMemoryPhase2EngineError,
  materializePiAgentModelConfig,
  runPiOfficialRpcMode,
  runPiMemoryPhase2MountedConsolidation,
  type PiAgentModelConfig,
  type PiLangfuseRuntimeConfig,
  type PiMemoryRecallOutcome,
  type PiMemoryToolSourceUse,
  type PiPreparationObservation,
} from "@okouai/pi-agent-runtime/node";
import { piLangfuseTracesContract } from "@okouai/api-contracts/contracts/pi-langfuse";
import {
  PI_PREPARATION_TIMING_ENV,
  startPiCliObservation,
  writePiPreparationTiming,
} from "./pi-startup-timing";

const RUN_ID_ENV = "OKOU_RUN_ID";
const PI_SESSION_ID_ENV = "OKOU_PI_SESSION_ID";
const PI_LAUNCH_PAYLOAD_FILE_ENV = "OKOU_PI_LAUNCH_PAYLOAD_FILE";
const PI_MODEL_CONFIG_ENV = "OKOU_PI_MODEL_CONFIG";
const PI_MEMORY_PHASE2_VALIDATION_FILENAME = "maintenance-validation.json";

function recordPiMemoryRecallOutcome(
  runId: string,
  outcome: PiMemoryRecallOutcome,
): void {
  process.stderr.write(
    `${JSON.stringify({ type: "pi_memory_recall_outcome", runId, ...outcome })}\n`,
  );
}

export function recordPiMemoryToolSourceUse(
  runId: string,
  sessionId: string,
  sourceUse: PiMemoryToolSourceUse,
): void {
  process.stderr.write(
    `${JSON.stringify({
      type: "pi_memory_tool_source_use",
      runId,
      sessionId,
      ...sourceUse,
    })}\n`,
  );
}

/**
 * Report one sandbox session-preparation phase to guest-agent.
 *
 * The sandbox host has no telemetry sink of its own, so guest-agent stays the
 * single writer of the sandbox operation log: it recognizes this envelope on
 * stderr and records `pi_prepare_<phase>`. The ingestion boundary then stamps
 * `source: sandbox`.
 */
export function recordPiPreparationTiming(
  runId: string,
  observation: PiPreparationObservation,
): void {
  writePiPreparationTiming(runId, observation);
}

export interface PiSandboxAgentConfig {
  readonly runId: string;
  readonly sessionId: string;
  readonly launchPayload: PiLaunchPayload;
  readonly model: PiAgentModelConfig;
  /** guest-agent owns the sandbox operation log and opts this child in. */
  readonly reportPreparationTiming: boolean;
  readonly langfuseConfig?: PiLangfuseRuntimeConfig;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required for Pi execution`);
  }
  return value;
}

function parseJsonEnv(env: NodeJS.ProcessEnv, name: string): unknown {
  const value = requiredEnv(env, name);
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${name} must contain valid JSON`, { cause: error });
  }
}

async function readLaunchPayload(
  env: NodeJS.ProcessEnv,
): Promise<PiLaunchPayload> {
  const finish = startPiCliObservation("cli_launch_payload");
  let outcome: "success" | "error" = "error";
  try {
    const path = requiredEnv(env, PI_LAUNCH_PAYLOAD_FILE_ENV);
    const raw = await readFile(path, "utf8");
    const payload = piLaunchPayloadSchema.parse(JSON.parse(raw) as unknown);
    outcome = "success";
    return payload;
  } finally {
    finish(outcome);
  }
}

function isPiSessionFileName(name: string, sessionId: string): boolean {
  if (!name.endsWith(".jsonl")) {
    return false;
  }
  const stem = name.slice(0, -".jsonl".length);
  return (
    stem === sessionId ||
    stem.endsWith(`-${sessionId}`) ||
    stem.endsWith(`_${sessionId}`)
  );
}

/**
 * Open the run's Pi session file, creating a fresh one on the first turn.
 *
 * The Runner restores a resumed session from the execution context's
 * `resumeSession` (inline `sessionHistory` or blob `historyRef`) as
 * `restored-<sessionId>.jsonl`; a reused sandbox keeps the file its previous
 * run appended to. The most recently modified file for the session wins.
 */
async function resolvePiSessionFile(args: {
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly cwd: string;
}): Promise<string> {
  const finish = startPiCliObservation("cli_session_file");
  let outcome: "success" | "error" = "error";
  try {
    const names = await readdir(args.sessionDir).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return [];
        }
        throw error;
      },
    );
    let latest: { readonly path: string; readonly modifiedAt: number } | null =
      null;
    for (const name of names) {
      if (!isPiSessionFileName(name, args.sessionId)) {
        continue;
      }
      const path = join(args.sessionDir, name);
      const { mtimeMs } = await stat(path);
      if (latest === null || mtimeMs > latest.modifiedAt) {
        latest = { path, modifiedAt: mtimeMs };
      }
    }
    if (latest !== null) {
      outcome = "success";
      return latest.path;
    }
    const sessionFile = join(args.sessionDir, `${args.sessionId}.jsonl`);
    await mkdir(args.sessionDir, { recursive: true });
    const file = await open(sessionFile, "wx", 0o600);
    try {
      await file.writeFile(
        createPiSessionJsonl({
          cwd: args.cwd,
          sessionId: args.sessionId,
          timestamp: new Date().toISOString(),
        }),
        "utf8",
      );
    } finally {
      await file.close();
    }
    outcome = "success";
    return sessionFile;
  } finally {
    finish(outcome);
  }
}

/**
 * Resolve immutable Pi runtime inputs injected by guest-agent.
 *
 * Prompt-sized inputs arrive through the private launch payload file rather
 * than the child environment, so this reads that file before the first turn.
 */
export async function piSandboxAgentConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PiSandboxAgentConfig> {
  const finishConfig = startPiCliObservation("cli_config");
  let configOutcome: "success" | "error" = "error";
  try {
    const runId = requiredEnv(env, RUN_ID_ENV);
    const langfuseConfig = piLangfuseRelayConfig(env, runId);
    const parsedModel = piModelConfigSchema.parse(
      parseJsonEnv(env, PI_MODEL_CONFIG_ENV),
    );
    const config = {
      runId,
      sessionId: requiredEnv(env, PI_SESSION_ID_ENV),
      launchPayload: await readLaunchPayload(env),
      reportPreparationTiming: env[PI_PREPARATION_TIMING_ENV] === "1",
      model: await materializeSandboxModel(parsedModel, env),
      ...(langfuseConfig ? { langfuseConfig } : {}),
    };
    configOutcome = "success";
    return config;
  } finally {
    finishConfig(configOutcome);
  }
}

async function materializeSandboxModel(
  config: ReturnType<typeof piModelConfigSchema.parse>,
  env: NodeJS.ProcessEnv,
): Promise<PiAgentModelConfig> {
  const finish = startPiCliObservation("cli_credentials");
  let outcome: "success" | "error" = "error";
  try {
    const model = await materializePiAgentModelConfig({
      config,
      resolveCredential(binding) {
        return requiredEnv(env, binding.environment);
      },
    });
    outcome = "success";
    return model;
  } finally {
    finish(outcome);
  }
}

function piLangfuseRelayConfig(
  env: NodeJS.ProcessEnv,
  runId: string,
): PiLangfuseRuntimeConfig | undefined {
  if (env.OKOU_PI_LANGFUSE_DEBUG_ENABLED !== "true") {
    return undefined;
  }
  const apiUrl = requiredEnv(env, "OKOU_API_BACKEND_URL");
  const endpoint = new URL(
    piLangfuseTracesContract.export.path.replace(
      ":runId",
      encodeURIComponent(runId),
    ),
    apiUrl.startsWith("http") ? apiUrl : `https://${apiUrl}`,
  ).toString();
  return {
    relay: { endpoint, token: requiredEnv(env, "OKOU_TOKEN") },
    userId: env.LANGFUSE_USER_ID,
    environment: env.LANGFUSE_TRACING_ENVIRONMENT,
  };
}

/**
 * Open the run's Pi session and run the official sandbox-owned Pi RPC host.
 *
 * The sandbox owns the whole turn. This host writes the private startup
 * control before entering `runPiOfficialRpcMode`.
 *
 * The guest-agent consumes that control record before admitting any official
 * Pi RPC record, so the control is not an agent event, Chat event, transcript
 * line, or public delivery. `runPiOfficialRpcMode` owns the official RPC
 * command/record stream; guest-agent owns its stdin and keeps it open through
 * `agent_settled`, closing it only after terminal handling and active-input
 * quiescence. The host consequently remains in official RPC mode until the
 * guest closes stdin.
 */
export async function runPiSandboxAgentLoop(args: {
  readonly config: PiSandboxAgentConfig;
  readonly cwd?: string;
  readonly agentDir?: string;
  readonly sessionDir?: string;
  readonly memoryRoot?: string;
  readonly maintenanceValidationFile?: string;
}): Promise<void> {
  const maintenance = args.config.launchPayload.launchConfig.maintenance;
  if (maintenance) {
    const validationFile =
      args.maintenanceValidationFile ??
      join(
        dirname(requiredEnv(process.env, PI_LAUNCH_PAYLOAD_FILE_ENV)),
        PI_MEMORY_PHASE2_VALIDATION_FILENAME,
      );
    await unlink(validationFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    const result = await runPiMemoryPhase2MountedConsolidation(
      {
        memoryRoot: args.memoryRoot ?? PI_MEMORY_ROOT,
        memoryStorageId: maintenance.memoryStorageId,
        claimedBaseVersionId: maintenance.claimedBaseVersionId,
        selectionDigest: maintenance.selectionDigest,
        selected: maintenance.selected.map((candidate) => {
          return {
            ...candidate,
            sourceCompletedAt: new Date(candidate.sourceCompletedAt),
          };
        }),
        model: args.config.model,
      },
      AbortSignal.timeout(2 * 60 * 60 * 1000),
    );
    const marker = {
      schemaVersion: 1,
      runId: args.config.runId,
      memoryStorageId: maintenance.memoryStorageId,
      claimedRevision: maintenance.claimedRevision,
      claimedBaseVersionId: maintenance.claimedBaseVersionId,
      leaseToken: maintenance.leaseToken,
      selectionDigest: maintenance.selectionDigest,
      validatedVersionId: result.validatedVersionId,
    } as const;
    const file = await open(validationFile, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(marker), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    return;
  }
  const sessionDir = args.sessionDir ?? CANONICAL_PI_SESSION_DIR;
  const cwd = args.cwd ?? process.cwd();
  const sessionFile = await resolvePiSessionFile({
    sessionDir,
    sessionId: args.config.sessionId,
    cwd,
  });
  return await runPiOfficialRpcMode({
    sessionId: args.config.sessionId,
    sessionDir,
    cwd,
    agentDir: args.agentDir ?? PI_AGENT_DIR,
    model: args.config.model,
    appendSystemPrompt: args.config.launchPayload.appendSystemPrompt,
    memoryRecall: args.config.launchPayload.launchConfig.memoryRecall,
    onMemoryRecallOutcome(outcome) {
      recordPiMemoryRecallOutcome(args.config.runId, outcome);
    },
    onMemoryToolSourceUse(sourceUse) {
      recordPiMemoryToolSourceUse(
        args.config.runId,
        args.config.sessionId,
        sourceUse,
      );
    },
    ...(args.config.reportPreparationTiming
      ? {
          onPreparationTiming(observation: PiPreparationObservation) {
            recordPiPreparationTiming(args.config.runId, observation);
          },
        }
      : {}),
    sessionFile,
    ...(args.config.langfuseConfig
      ? { langfuseConfig: args.config.langfuseConfig }
      : {}),
  });
}

/** Preserve terminal status even if the best-effort stderr sink throws. */
export function reportPiSandboxAgentLoopFailure(error: unknown): void {
  process.exitCode = 1;
  try {
    console.error(
      error instanceof PiMemoryPhase2EngineError
        ? error.terminalMessage()
        : error instanceof Error
          ? error.message
          : String(error),
    );
  } catch {
    // The diagnostic sink cannot turn a failed maintenance run into success.
  }
}
