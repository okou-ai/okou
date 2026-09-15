import { open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CANONICAL_PI_SESSION_DIR,
  PI_AGENT_DIR,
  PI_MEMORY_ROOT,
  piLaunchPayloadSchema,
  piModelConfigSchema,
  type PiLaunchPayload,
} from "@okouai/api-contracts/contracts/runners";
import {
  PiMemoryPhase2EngineError,
  materializePiAgentModelConfig,
  runPiOfficialRpcMode,
  runPiMemoryPhase2MountedConsolidation,
  type PiAgentModelConfig,
  type PiLangfuseRuntimeConfig,
  type PiMemoryRecallOutcome,
  type PiMemoryToolSourceUse,
} from "@okouai/pi-agent-runtime/node";

import {
  resolvePiApiFirstTurnHandoff,
  type PiApiFirstTurnBoundaryControl,
} from "./pi-api-first-turn-handoff";

const RUN_ID_ENV = "OKOU_RUN_ID";
const PI_SESSION_ID_ENV = "OKOU_PI_SESSION_ID";
const PI_LAUNCH_PAYLOAD_FILE_ENV = "OKOU_PI_LAUNCH_PAYLOAD_FILE";
const PI_MODEL_CONFIG_ENV = "OKOU_PI_MODEL_CONFIG";
const PI_LANGFUSE_CONFIG_FILE_ENV = "OKOU_PI_LANGFUSE_CONFIG_FILE";
const PI_LANGFUSE_CONFIG_MAX_BYTES = 64 * 1024;
const PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE =
  "vm0_pi_api_first_turn_boundary";
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

export interface PiSandboxAgentConfig {
  readonly runId: string;
  readonly sessionId: string;
  readonly launchPayload: PiLaunchPayload;
  readonly model: PiAgentModelConfig;
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

function nonemptyString(
  value: unknown,
  maxLength: number = PI_LANGFUSE_CONFIG_MAX_BYTES,
): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : undefined;
}

function parsePiLangfuseBootstrapConfig(
  raw: Buffer,
): PiLangfuseRuntimeConfig | undefined {
  if (raw.length === 0 || raw.length > PI_LANGFUSE_CONFIG_MAX_BYTES) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const publicKey = nonemptyString(record.publicKey);
    const secretKey = nonemptyString(record.secretKey);
    if (!publicKey || !secretKey) {
      return undefined;
    }
    const baseUrl = nonemptyString(record.baseUrl);
    if (baseUrl) {
      const parsedUrl = new URL(baseUrl);
      if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
        return undefined;
      }
    }
    const userId = nonemptyString(record.userId);
    const environment = nonemptyString(record.environment);
    return {
      publicKey,
      secretKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...(userId ? { userId } : {}),
      ...(environment ? { environment } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function consumePiLangfuseBootstrapConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PiLangfuseRuntimeConfig | undefined> {
  const path = env[PI_LANGFUSE_CONFIG_FILE_ENV];
  delete env[PI_LANGFUSE_CONFIG_FILE_ENV];
  if (!path) {
    return undefined;
  }
  let file;
  try {
    file = await open(path, "r+");
  } catch {
    return undefined;
  }
  try {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try {
          await file.truncate(0);
        } catch (cleanupError) {
          throw new Error("Pi Langfuse bootstrap file could not be removed", {
            cause: cleanupError,
          });
        }
        return undefined;
      }
    }
    const raw = Buffer.alloc(PI_LANGFUSE_CONFIG_MAX_BYTES + 1);
    try {
      const { bytesRead } = await file.read(raw, 0, raw.length, 0);
      return parsePiLangfuseBootstrapConfig(raw.subarray(0, bytesRead));
    } catch {
      return undefined;
    } finally {
      raw.fill(0);
    }
  } finally {
    await file.close();
  }
}

async function readLaunchPayload(
  env: NodeJS.ProcessEnv,
): Promise<PiLaunchPayload> {
  const path = requiredEnv(env, PI_LAUNCH_PAYLOAD_FILE_ENV);
  const raw = await readFile(path, "utf8");
  return piLaunchPayloadSchema.parse(JSON.parse(raw) as unknown);
}

async function writePiApiFirstTurnBoundaryControl(
  control: PiApiFirstTurnBoundaryControl,
): Promise<void> {
  const line = `${JSON.stringify({
    type: PI_API_FIRST_TURN_BOUNDARY_CONTROL_TYPE,
    ...control,
  })}\n`;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(line, (error) => {
      if (error) {
        reject(
          new Error("Pi API first-turn boundary control could not be written", {
            cause: error,
          }),
        );
      } else {
        resolve();
      }
    });
  });
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
  const langfuseConfig = await consumePiLangfuseBootstrapConfig(env);
  const runId = requiredEnv(env, RUN_ID_ENV);
  const parsedModel = piModelConfigSchema.parse(
    parseJsonEnv(env, PI_MODEL_CONFIG_ENV),
  );
  return {
    runId,
    sessionId: requiredEnv(env, PI_SESSION_ID_ENV),
    launchPayload: await readLaunchPayload(env),
    model: await materializePiAgentModelConfig({
      config: parsedModel,
      target: "sandbox-firewall",
      resolveCredential(binding) {
        return requiredEnv(env, binding.environment);
      },
    }),
    ...(langfuseConfig ? { langfuseConfig } : {}),
  };
}

/**
 * Resolve the API-first handoff and run the official sandbox-owned Pi RPC host.
 *
 * The handoff resolver validates the immutable manifest, authoritative session,
 * and ownership mode. V3 and V4 manifests emit a schema V2 private control
 * carrying the explicit ownership mode. This host writes that control before
 * entering `runPiOfficialRpcMode`.
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
  const handoff = await resolvePiApiFirstTurnHandoff({
    config: args.config.launchPayload.launchConfig.apiFirstTurn,
    sessionDir,
    sessionId: args.config.sessionId,
  });
  await writePiApiFirstTurnBoundaryControl(handoff.boundaryControl);
  return await runPiOfficialRpcMode({
    sessionId: args.config.sessionId,
    sessionDir,
    cwd: args.cwd ?? process.cwd(),
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
    sessionFile: handoff.sessionFile,
    ownershipTransferMode: handoff.ownershipTransferMode,
    ...(handoff.langfuseParent
      ? { langfuseParent: handoff.langfuseParent }
      : {}),
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
