import { readFile } from "node:fs/promises";

import {
  CANONICAL_PI_SESSION_DIR,
  PI_AGENT_DIR,
  piLaunchPayloadSchema,
  piModelConfigSchema,
  type PiLaunchPayload,
} from "@okouai/api-contracts/contracts/runners";
import {
  materializePiAgentModelConfig,
  runPiOfficialRpcMode,
  type PiAgentModelConfig,
  type PiPreparationObservation,
} from "@okouai/pi-agent-runtime/node";
import {
  PI_PREPARATION_TIMING_ENV,
  startPiCliObservation,
  writePiPreparationTiming,
} from "./pi-startup-timing";

import { PI_EFFECTIVE_THINKING_ENV } from "./pi-session-env";

const RUN_ID_ENV = "OKOU_RUN_ID";
const PI_LAUNCH_PAYLOAD_FILE_ENV = "OKOU_PI_LAUNCH_PAYLOAD_FILE";
const PI_MODEL_CONFIG_ENV = "OKOU_PI_MODEL_CONFIG";

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
  readonly launchPayload: PiLaunchPayload;
  readonly model: PiAgentModelConfig;
  /** guest-agent owns the sandbox operation log and opts this child in. */
  readonly reportPreparationTiming: boolean;
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
    const modelInput = piModelConfigSchema.parse(
      parseJsonEnv(env, PI_MODEL_CONFIG_ENV),
    );
    const parsedModel = piModelConfigSchema.parse({
      ...modelInput,
      ...(env[PI_EFFECTIVE_THINKING_ENV]
        ? { thinkingLevel: env[PI_EFFECTIVE_THINKING_ENV] }
        : {}),
    });
    const config = {
      runId,
      launchPayload: await readLaunchPayload(env),
      reportPreparationTiming: env[PI_PREPARATION_TIMING_ENV] === "1",
      model: await materializeSandboxModel(parsedModel, env),
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
    // Preserve thread-scoped upstream prompt-cache affinity.
    const affinityKey = env.OKOU_CHAT_THREAD_ID?.trim();
    return model.dialect === "openai-completions" && affinityKey
      ? { ...model, sessionAffinityKey: affinityKey }
      : model;
  } finally {
    finish(outcome);
  }
}

/**
 * Open or continue the run's Pi session and run the official sandbox-owned Pi RPC host.
 */
export async function runPiSandboxAgentLoop(args: {
  readonly config: PiSandboxAgentConfig;
  readonly cwd?: string;
  readonly agentDir?: string;
  readonly sessionDir?: string;
}): Promise<void> {
  const sessionDir = args.sessionDir ?? CANONICAL_PI_SESSION_DIR;
  const cwd = args.cwd ?? process.cwd();
  return await runPiOfficialRpcMode({
    sessionRole: "parent",
    continueNative: args.config.launchPayload.continueNative ?? false,
    sessionDir,
    cwd,
    agentDir: args.agentDir ?? PI_AGENT_DIR,
    model: args.config.model,
    appendSystemPrompt: args.config.launchPayload.appendSystemPrompt,
    ...(args.config.reportPreparationTiming
      ? {
          onPreparationTiming(observation: PiPreparationObservation) {
            recordPiPreparationTiming(args.config.runId, observation);
          },
        }
      : {}),
  });
}

/** Preserve terminal status even if the best-effort stderr sink throws. */
export function reportPiSandboxAgentLoopFailure(error: unknown): void {
  process.exitCode = 1;
  try {
    console.error(error instanceof Error ? error.message : String(error));
  } catch {
    // The diagnostic sink cannot turn a failed Run into success.
  }
}
