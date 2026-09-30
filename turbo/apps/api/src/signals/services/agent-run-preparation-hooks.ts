import { testOverride } from "../../lib/singleton";

export type RunContextParallelStage =
  | "connector-contexts"
  | "model-provider"
  | "user-timezone"
  | "image-model"
  | "official-workflow";

type RunContextParallelHook = (args: {
  readonly stage: RunContextParallelStage;
  readonly userId: string;
  readonly orgId: string;
}) => Promise<void>;

const runContextParallelHook = testOverride<RunContextParallelHook | undefined>(
  () => {
    return undefined;
  },
);

export function setRunContextParallelHookForTest(
  hook: RunContextParallelHook,
): void {
  runContextParallelHook.set(hook);
}

export function clearRunContextParallelHookForTest(): void {
  runContextParallelHook.clear();
}

export function observeRunContextParallelStage(
  stage: RunContextParallelStage,
  args: { readonly userId: string; readonly orgId: string },
): Promise<void> | undefined {
  return runContextParallelHook.get()?.({
    stage,
    userId: args.userId,
    orgId: args.orgId,
  });
}

export interface AgentRunPiExecutionSnapshot {
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string | undefined;
  readonly piExecution: boolean;
  readonly threadSessionCliAgentType: string | null | undefined;
}

type AgentRunPiExecutionSnapshotHook = (
  snapshot: AgentRunPiExecutionSnapshot,
) => Promise<void>;

const agentRunPiExecutionSnapshotHook = testOverride<
  AgentRunPiExecutionSnapshotHook | undefined
>(() => {
  return undefined;
});

export function setAgentRunPiExecutionSnapshotHookForTest(
  hook: AgentRunPiExecutionSnapshotHook,
): void {
  agentRunPiExecutionSnapshotHook.set(hook);
}

export function clearAgentRunPiExecutionSnapshotHookForTest(): void {
  agentRunPiExecutionSnapshotHook.clear();
}

type StableAgentPromptBuildHook = () => void;

type StableContextCacheIdentityBuildHook = () => void;

const stableAgentPromptBuildHook = testOverride<
  StableAgentPromptBuildHook | undefined
>(() => {
  return undefined;
});

const stableContextCacheIdentityBuildHook = testOverride<
  StableContextCacheIdentityBuildHook | undefined
>(() => {
  return undefined;
});

export function setStableAgentPromptBuildHookForTest(
  hook: StableAgentPromptBuildHook,
): void {
  stableAgentPromptBuildHook.set(hook);
}

export function clearStableAgentPromptBuildHookForTest(): void {
  stableAgentPromptBuildHook.clear();
}

export function setStableContextCacheIdentityBuildHookForTest(
  hook: StableContextCacheIdentityBuildHook,
): void {
  stableContextCacheIdentityBuildHook.set(hook);
}

export function clearStableContextCacheIdentityBuildHookForTest(): void {
  stableContextCacheIdentityBuildHook.clear();
}

export type AgentRunPreCreateParallelStage =
  | "subscription-account"
  | "post-authorization-context"
  | "thread-session";

type AgentRunPreCreateParallelHook = (args: {
  readonly stage: AgentRunPreCreateParallelStage;
  readonly userId: string;
  readonly orgId: string;
}) => Promise<void>;

const agentRunPreCreateParallelHook = testOverride<
  AgentRunPreCreateParallelHook | undefined
>(() => {
  return undefined;
});

export function setAgentRunPreCreateParallelHookForTest(
  hook: AgentRunPreCreateParallelHook,
): void {
  agentRunPreCreateParallelHook.set(hook);
}

export function clearAgentRunPreCreateParallelHookForTest(): void {
  agentRunPreCreateParallelHook.clear();
}

export function observeAgentRunPreCreateParallelStage(
  stage: AgentRunPreCreateParallelStage,
  input: {
    readonly command: {
      readonly auth: { readonly userId: string; readonly orgId: string };
    };
  },
): Promise<void> | undefined {
  return agentRunPreCreateParallelHook.get()?.({
    stage,
    userId: input.command.auth.userId,
    orgId: input.command.auth.orgId,
  });
}

export function observeAgentRunPiExecutionSnapshot(
  snapshot: AgentRunPiExecutionSnapshot,
): Promise<void> | undefined {
  return agentRunPiExecutionSnapshotHook.get()?.(snapshot);
}

export function observeStableAgentPromptBuild(): void {
  stableAgentPromptBuildHook.get()?.();
}

export function observeStableContextCacheIdentityBuild(): void {
  stableContextCacheIdentityBuildHook.get()?.();
}

const runConnectorAccountsReadHook = testOverride<
  (() => Promise<void>) | undefined
>(() => {
  return undefined;
});

export function setRunConnectorAccountsReadHookForTest(
  hook: () => Promise<void>,
): void {
  runConnectorAccountsReadHook.set(hook);
}

export function clearRunConnectorAccountsReadHookForTest(): void {
  runConnectorAccountsReadHook.clear();
}

export function observeRunConnectorAccountsRead(): Promise<void> | undefined {
  return runConnectorAccountsReadHook.get()?.();
}
