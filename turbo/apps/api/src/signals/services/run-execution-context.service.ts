/**
 * Prepared run context composition and finalization (launch snapshot, final
 * append system prompt, official workflow run candidates and run output
 * metadata). Moved verbatim out of the legacy execution graph.
 */
import {
  type OfficialWorkflowRunObservation,
  OfficialWorkflowRunAdmissionError,
} from "./official-workflow-run.service";
import type { ReadonlyDb } from "../external/db";
import {
  ApiDispatchTimingCollector,
  ApiDispatchPhaseCollector,
} from "./api-dispatch-timing.service";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import type { SupportedFramework } from "@okouai/core/frameworks";
import type { PersistedStorageMount } from "@okouai/db/types";
import {
  getSkillStorageName,
  getCustomSkillStorageName,
  getCustomConnectorSkillStorageName,
  getCustomConnectorSkillName,
} from "@okouai/core/storage-names";
import {
  type PiModelConfig,
  PI_MEMORY_ROOT,
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
} from "@okouai/api-contracts/contracts/runners";
import {
  type ModelProviderType,
  getModelImageInputSupport,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  type SessionExecutionIdentity,
  canReuseSession,
} from "./session-compatibility";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { RunWorkflowRef } from "./workflow-data.service";
import {
  type ImageModel,
  IMAGE_MODEL_CONFIGS,
} from "@okouai/core/image-model-catalog";
import {
  type ConnectorRuntimeSelection,
  getConnectorRuntimeConnector,
} from "./connector-catalog-runtime.service";
import type { SystemSkillStorageResolution } from "../context/system-skill-storage-resolution";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { resolveSkillRef, parseGitHubTreeUrl } from "@okouai/core/github-url";
import { isWebChatTriggerSource } from "./chat-trigger-source.service";
import type { CustomConnectorRuntimeContext } from "./connector-runtime-preparation.service";
import {
  AdditionalVolumeSources,
  AgentRunCreateAdditionalVolume,
  AgentRunCreateContextArtifact,
  ArtifactMissingRootPolicy,
  BuiltinConnectorRuntimeContext,
  CreateAgentRunArgs,
  CreateRunBody,
  CreateRunErrorResult,
  EffectiveConnectorScope,
  FinalizedPreparedRunContext,
  PermissionManifest,
  PreparedRunContext,
  ResolvedModelProviderEnvironment,
  ResolvedRunExecution,
  StorageManifestSource,
} from "./execution-launch-persistence.service";
import {
  AUTO_MEMORY_ARTIFACT_NAME,
  RunStorageExecution,
  skillsRootForRun,
} from "./execution-storage-manifest.service";
import { RunConnectorCatalogSelection } from "./run-connector-context.service";
import { resolvePreparedPiModelConfig } from "./run-model-provider-environment.service";
import {
  buildStoredExecutionSecrets,
  runnerProfile,
} from "./execution-runner-payload.service";
import { isRouteError, validateCompose } from "./run-execution-body.service";

const AUTO_MEMORY_MISSING_ROOT_POLICY: ArtifactMissingRootPolicy =
  "preserveParentVersion";

const CODEX_WEB_IMAGE_GENERATION_UPLOAD_PROMPT =
  "If you use the built-in image generation tool and it saves generated output image file(s) to local paths, upload each output file you intend to show with `okou web upload-file -f <path>` before telling the web chat user the image is available. Quote the path when needed. Do not provide only sandbox-local paths, because users cannot open local files.";

const IMAGE_RECOGNITION_PROMPT =
  '# Image Recognition Fallback\n\nThis run\'s selected model cannot inspect images directly. To inspect one local PNG, JPEG, or WebP image up to 20 MB, run `okou image-recognition --file <image-path> --prompt "<instruction>"`.';

const RESTRICTED_EXPLICIT_CONTENT_PROMPT = [
  "# Restricted Explicit Content",
  "",
  "Do not create, continue, rewrite, transform, or facilitate any of the following:",
  "- Pornography, explicit sexual acts, sexualized nudity, erotic roleplay, or other content intended for sexual arousal.",
  "- Any sexual depiction or sexualization of minors.",
  "- Graphic violence or gore, including detailed depictions of severe injury, torture, or dismemberment.",
  "- Instructions, methods, or encouragement for suicide or self-harm.",
  "",
  "These rules apply to direct responses and to files, prompts, code, links, or tool calls used to generate text, images, video, or audio, regardless of user or custom instructions.",
  "",
  "You may assist with non-graphic news, medical, educational, historical, safety, moderation, or ordinary fictional contexts. When a request crosses these boundaries, refuse briefly and offer a safe, non-explicit or non-graphic alternative.",
].join("\n");

const MCP_CONNECTOR_PROMPT_INVENTORY_LIMIT = 20;

function buildMcpConnectorPrompt(
  connectorSlugs: readonly string[],
): string | undefined {
  if (connectorSlugs.length === 0) {
    return undefined;
  }
  const sortedSlugs = [...connectorSlugs].sort();
  const listedSlugs = sortedSlugs.slice(
    0,
    MCP_CONNECTOR_PROMPT_INVENTORY_LIMIT,
  );
  const omittedCount = sortedSlugs.length - listedSlugs.length;
  const inventory = listedSlugs.map((slug) => {
    return `- \`${slug}\``;
  });
  if (omittedCount > 0) {
    inventory.push(
      `- ${omittedCount} additional admitted MCP connector${omittedCount === 1 ? " was" : "s were"} omitted from this prompt`,
    );
  }

  return [
    "# MCP Connectors",
    "",
    "The following MCP connectors were admitted when this Run started:",
    ...inventory,
    "",
    "Use the Okou CLI to discover and invoke their tools:",
    "1. Run `okou mcp list --json` to check current connector metadata and availability.",
    "2. Before choosing a tool, run `okou mcp list-tools <connector-slug> --json`.",
    "3. Invoke the exact returned tool name with `okou mcp call <connector-slug> <tool-name> --input '<json>' --json`, providing JSON that matches its input schema.",
    "",
    "Current connector authorization or configuration may differ from this Run-start snapshot. Runner enforcement is authoritative; if discovery or invocation reports that a connector is unavailable, do not bypass it and start a new Run after authorization is updated.",
  ].join("\n");
}

function builtInImageModelPrompt(model: ImageModel): string {
  const alias = IMAGE_MODEL_CONFIGS[model].alias;
  return [
    "# Built-in image model",
    "",
    `Built-in image generation uses \`${alias}\`, from the user's image model setting in Settings › Built-in tools.`,
    "- The model cannot be changed per request. Do not pass `--model` to image generation commands.",
    "- If the user asks for a different built-in image model, tell them to change it in Settings › Built-in tools.",
    "- Image generation through a connected third-party service chooses its model separately; this setting does not apply to that path.",
  ].join("\n");
}

export function withFinalRunAppendSystemPrompt(args: {
  readonly body: CreateRunBody;
  readonly framework: SupportedFramework;
  readonly chatThreadId: string | undefined;
  readonly imageRecognitionAvailable: boolean;
  readonly mcpConnectorSlugs: readonly string[];
  readonly selectedImageModel: ImageModel;
  readonly cliAvailable: boolean;
}): CreateRunBody {
  const appendedParts: string[] = [];
  if (args.cliAvailable) {
    const mcpConnectorPrompt = buildMcpConnectorPrompt(args.mcpConnectorSlugs);
    if (mcpConnectorPrompt) {
      appendedParts.push(mcpConnectorPrompt);
    }
  }
  if (args.imageRecognitionAvailable) {
    appendedParts.push(IMAGE_RECOGNITION_PROMPT);
  }
  if (
    args.framework === "codex" &&
    isWebChatTriggerSource(args.body.triggerSource) &&
    args.chatThreadId
  ) {
    appendedParts.push(CODEX_WEB_IMAGE_GENERATION_UPLOAD_PROMPT);
  }
  appendedParts.push(builtInImageModelPrompt(args.selectedImageModel));
  // Keep this policy last so custom and integration prompts cannot override it.
  appendedParts.push(RESTRICTED_EXPLICIT_CONTENT_PROMPT);

  return {
    ...args.body,
    appendSystemPrompt: [args.body.appendSystemPrompt, ...appendedParts]
      .filter((part): part is string => {
        return Boolean(part);
      })
      .join("\n\n"),
  };
}

interface RunArtifacts {
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
}

interface PreparedAdditionalVolume {
  readonly volume: AgentRunCreateAdditionalVolume;
  readonly source: StorageManifestSource;
}

interface PreparedAdditionalVolumes {
  readonly volumes: readonly AgentRunCreateAdditionalVolume[] | undefined;
  readonly sources: AdditionalVolumeSources;
}

function mergeAdditionalVolumes(args: {
  readonly prepend: readonly PreparedAdditionalVolume[] | undefined;
  readonly base: readonly PreparedAdditionalVolume[] | undefined;
}): PreparedAdditionalVolumes {
  const prepared =
    args.prepend || args.base
      ? [...(args.prepend ?? []), ...(args.base ?? [])]
      : undefined;
  return {
    volumes: prepared?.map((item) => {
      return item.volume;
    }),
    sources: prepared?.map((item) => {
      return item.source;
    }),
  };
}

function prepareAdditionalVolumesWithSource(
  volumes: readonly AgentRunCreateAdditionalVolume[] | undefined,
  source: StorageManifestSource,
): readonly PreparedAdditionalVolume[] | undefined {
  return volumes?.map((volume) => {
    return { volume, source };
  });
}

function skillMountPath(skillsRoot: string, skillName: string): string {
  return `${skillsRoot}/${skillName}`;
}

type ConnectorSkillVolumeSource = Extract<
  StorageManifestSource,
  "connector_skill" | "custom_connector_skill"
>;

function buildExactConnectorSkillVolume(args: {
  readonly name: string;
  readonly version: string;
  readonly mountPath: string;
  readonly source: ConnectorSkillVolumeSource;
}): PreparedAdditionalVolume {
  return {
    volume: {
      name: args.name,
      version: args.version,
      mountPath: args.mountPath,
      ...(args.source === "connector_skill" ? { system: true } : {}),
    },
    source: args.source,
  };
}

// Legacy CLI runs use the framework resolved from the model provider, never
// the framework declared in the compose. Eligible Pi runs instead receive the
// fixed Pi root before Storage resolves any versions or overlays.
function buildLegacySystemSkillVolumes(
  skillNames: readonly string[],
  skillsRoot: string,
  storageResolution: SystemSkillStorageResolution,
): readonly AgentRunCreateAdditionalVolume[] {
  return [...new Set(skillNames)].flatMap((skillName) => {
    const url = resolveSkillRef(skillName);
    const parsed = parseGitHubTreeUrl(url);
    if (!parsed) {
      return [];
    }
    return [
      {
        name:
          storageResolution[skillName] ?? getSkillStorageName(parsed.fullPath),
        mountPath: skillMountPath(skillsRoot, parsed.skillName),
        system: true,
      },
    ];
  });
}

function buildConnectorSkillVolumes(
  connectorSlugs: readonly ConnectorSlug[],
  snapshot: ConnectorRuntimeSelection,
  skillsRoot: string,
): readonly PreparedAdditionalVolume[] {
  return connectorSlugs.flatMap((connectorSlug) => {
    const connector = getConnectorRuntimeConnector(snapshot, connectorSlug);
    if (connector === undefined) {
      throw new Error("Accepted connector skill metadata is unavailable");
    }
    if (connector.skill.kind === "none") {
      return [];
    }
    const prepared = buildExactConnectorSkillVolume({
      name: connector.skill.storageName,
      version: connector.skill.versionId,
      mountPath: skillMountPath(skillsRoot, connectorSlug),
      source: "connector_skill",
    });
    return [prepared];
  });
}

function mountedWorkflowRefs(
  workflows: readonly RunWorkflowRef[],
): readonly RunWorkflowRef[] {
  return workflows.filter((workflow) => {
    return !SEED_SKILLS.includes(workflow.name);
  });
}

export function officialWorkflowRunCandidates(
  workflows: readonly RunWorkflowRef[],
  skillsRoot: string,
  requiredWorkflowIds: readonly string[],
): readonly {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly definitionName: string;
  readonly mountPath: string;
}[] {
  for (const workflow of workflows) {
    if (
      workflow.officialDefinitionName !== null &&
      SEED_SKILLS.includes(workflow.name)
    ) {
      throw new OfficialWorkflowRunAdmissionError();
    }
  }
  const candidates = mountedWorkflowRefs(workflows).flatMap((workflow) => {
    return workflow.officialDefinitionName === null
      ? []
      : [
          {
            workflowId: workflow.workflowId,
            workflowName: workflow.name,
            definitionName: workflow.officialDefinitionName,
            mountPath: skillMountPath(skillsRoot, workflow.name),
          },
        ];
  });
  const candidateWorkflowIds = new Set(
    candidates.map((candidate) => {
      return candidate.workflowId;
    }),
  );
  if (
    new Set(requiredWorkflowIds).size !== requiredWorkflowIds.length ||
    requiredWorkflowIds.some((workflowId) => {
      return !candidateWorkflowIds.has(workflowId);
    })
  ) {
    throw new OfficialWorkflowRunAdmissionError();
  }
  return candidates;
}

function buildWorkflowSkillVolumes(
  workflows: readonly RunWorkflowRef[],
  skillsRoot: string,
  officialWorkflowRun: OfficialWorkflowRunObservation | undefined,
): readonly PreparedAdditionalVolume[] {
  return mountedWorkflowRefs(workflows).map((workflow) => {
    if (workflow.officialDefinitionName !== null) {
      const definition = officialWorkflowRun?.definitions.find((candidate) => {
        return candidate.workflowId === workflow.workflowId;
      });
      if (!definition) {
        throw new OfficialWorkflowRunAdmissionError();
      }
      return {
        volume: {
          name: definition.artifact.storageName,
          version: definition.artifact.storageVersion,
          mountPath: definition.mountPath,
          system: true,
          expectedStorageId: definition.artifact.storageId,
        },
        source: "official_workflow" as const,
      };
    }
    return {
      volume: {
        // The volume is keyed by the workflow id; it mounts at the slug.
        name: getCustomSkillStorageName(workflow.workflowId),
        mountPath: skillMountPath(skillsRoot, workflow.name),
      },
      source: "workflow_skill" as const,
    };
  });
}

function buildCustomConnectorSkillVolumes(
  skills: CustomConnectorRuntimeContext["skills"],
  skillsRoot: string,
): readonly PreparedAdditionalVolume[] {
  return skills.map((skill) => {
    return buildExactConnectorSkillVolume({
      name: getCustomConnectorSkillStorageName(skill.connectorId),
      version: skill.versionId,
      mountPath: skillMountPath(
        skillsRoot,
        getCustomConnectorSkillName(skill.connectorSlug, skill.connectorId),
      ),
      source: "custom_connector_skill",
    });
  });
}

function buildInjectedSkillVolumes(
  args: {
    readonly injectSkillVolumes: CreateAgentRunArgs["injectSkillVolumes"];
    readonly systemSkillStorageResolution: SystemSkillStorageResolution;
    readonly allowedConnectorSlugs: readonly ConnectorSlug[];
    readonly connectorCatalogSelection: RunConnectorCatalogSelection;
    readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
  },
  skillsRoot: string,
): readonly PreparedAdditionalVolume[] | undefined {
  if (!args.injectSkillVolumes) {
    return undefined;
  }
  // Connector rollout switches govern discovery only. Once a connector slug is
  // part of a run, its accepted catalog skill remains executable and mountable.
  const systemSkillVolumes = [
    ...(prepareAdditionalVolumesWithSource(
      buildLegacySystemSkillVolumes(
        SEED_SKILLS,
        skillsRoot,
        args.systemSkillStorageResolution,
      ).map((volume) => {
        return { ...volume, baselineCandidate: true };
      }),
      "system_skill",
    ) ?? []),
    ...(args.connectorCatalogSelection.kind === "scoped"
      ? buildConnectorSkillVolumes(
          args.allowedConnectorSlugs,
          args.connectorCatalogSelection.selection,
          skillsRoot,
        )
      : []),
  ];
  return [
    ...systemSkillVolumes,
    ...buildWorkflowSkillVolumes(
      args.injectSkillVolumes.workflows,
      skillsRoot,
      args.officialWorkflowRun,
    ),
  ];
}

function autoMemoryMountPath(
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): string {
  if (piSandbox !== undefined) {
    return PI_MEMORY_ROOT;
  }
  return framework === "codex"
    ? CANONICAL_CODEX_MEMORY_MOUNT_PATH
    : CANONICAL_CLAUDE_MEMORY_MOUNT_PATH;
}

function autoMemoryArtifact(
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): AgentRunCreateContextArtifact {
  return withAutoMemoryMissingRootPolicy({
    name: AUTO_MEMORY_ARTIFACT_NAME,
    mountPath: autoMemoryMountPath(framework, piSandbox),
  });
}

function isCanonicalAutoMemoryArtifact(
  artifact: AgentRunCreateContextArtifact,
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): boolean {
  return (
    artifact.name === AUTO_MEMORY_ARTIFACT_NAME &&
    artifact.mountPath === autoMemoryMountPath(framework, piSandbox)
  );
}

function withAutoMemoryMissingRootPolicy(
  artifact: AgentRunCreateContextArtifact,
): AgentRunCreateContextArtifact {
  return {
    ...artifact,
    missingRootPolicy: AUTO_MEMORY_MISSING_ROOT_POLICY,
  };
}

function withCanonicalAutoMemoryMissingRootPolicy(
  artifacts: readonly AgentRunCreateContextArtifact[],
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): readonly AgentRunCreateContextArtifact[] {
  return artifacts.map((artifact) => {
    return isCanonicalAutoMemoryArtifact(artifact, framework, piSandbox)
      ? withAutoMemoryMissingRootPolicy(artifact)
      : artifact;
  });
}

function claimsAutoMemorySlot(
  artifact: AgentRunCreateContextArtifact,
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): boolean {
  return (
    artifact.name === AUTO_MEMORY_ARTIFACT_NAME ||
    artifact.mountPath === autoMemoryMountPath(framework, piSandbox)
  );
}

function withoutSupersededAutoMemoryArtifacts(
  artifacts: readonly AgentRunCreateContextArtifact[],
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
  slotOwnerIndex: number,
): readonly AgentRunCreateContextArtifact[] {
  return artifacts.filter((artifact, index) => {
    return (
      index >= slotOwnerIndex ||
      !isCanonicalAutoMemoryArtifact(artifact, framework, piSandbox)
    );
  });
}

function withPinnedPiContinuationMemory(
  artifacts: readonly AgentRunCreateContextArtifact[],
  previousRunStorageMounts: readonly PersistedStorageMount[] | undefined,
): readonly AgentRunCreateContextArtifact[] {
  const previousMemoryMount = previousRunStorageMounts?.find((mount) => {
    return (
      mount.name === AUTO_MEMORY_ARTIFACT_NAME &&
      mount.mountPath === PI_MEMORY_ROOT &&
      mount.version !== undefined
    );
  });
  if (!previousMemoryMount?.version) {
    return artifacts;
  }
  const pinnedMemoryArtifact = withAutoMemoryMissingRootPolicy({
    name: AUTO_MEMORY_ARTIFACT_NAME,
    version: previousMemoryMount.version,
    mountPath: PI_MEMORY_ROOT,
  });
  let slotOwnerIndex: number | undefined;
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (
      artifact &&
      (artifact.name === AUTO_MEMORY_ARTIFACT_NAME ||
        artifact.mountPath === PI_MEMORY_ROOT)
    ) {
      slotOwnerIndex = index;
      break;
    }
  }
  if (slotOwnerIndex === undefined) {
    return [...artifacts, pinnedMemoryArtifact];
  }
  const slotOwner = artifacts[slotOwnerIndex]!;
  if (
    slotOwner.name !== AUTO_MEMORY_ARTIFACT_NAME ||
    slotOwner.mountPath !== PI_MEMORY_ROOT
  ) {
    return artifacts;
  }
  return artifacts.map((artifact, index) => {
    return index === slotOwnerIndex ? pinnedMemoryArtifact : artifact;
  });
}

function artifactsForRun(args: {
  readonly resolved: Pick<
    ResolvedRunExecution,
    "agentSessionId" | "artifacts" | "previousRunStorageMounts"
  >;
  readonly framework: SupportedFramework;
  readonly piSandbox: PiModelConfig | undefined;
  readonly includeAutoMemory: boolean;
  readonly pinnedMemoryVersionId: string | undefined;
}): RunArtifacts {
  const isContinuation = Boolean(args.resolved.agentSessionId);
  const baseArtifacts =
    isContinuation && args.piSandbox !== undefined && args.includeAutoMemory
      ? withPinnedPiContinuationMemory(
          args.resolved.artifacts,
          args.resolved.previousRunStorageMounts,
        )
      : args.resolved.artifacts;
  // A producer-pinned memory baseline claims the auto-memory slot last.
  const artifacts =
    args.pinnedMemoryVersionId === undefined
      ? baseArtifacts
      : [
          ...baseArtifacts,
          {
            ...autoMemoryArtifact(args.framework, args.piSandbox),
            version: args.pinnedMemoryVersionId,
          },
        ];
  if (!args.includeAutoMemory) {
    return {
      artifacts: artifacts.filter((artifact) => {
        return (
          artifact.name !== AUTO_MEMORY_ARTIFACT_NAME &&
          artifact.mountPath !== PI_MEMORY_ROOT
        );
      }),
    };
  }

  let autoMemorySlotArtifactIndex: number | undefined;
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (
      artifact &&
      claimsAutoMemorySlot(artifact, args.framework, args.piSandbox)
    ) {
      autoMemorySlotArtifactIndex = index;
      break;
    }
  }
  if (autoMemorySlotArtifactIndex === undefined) {
    return {
      artifacts: [
        ...artifacts,
        autoMemoryArtifact(args.framework, args.piSandbox),
      ],
    };
  }

  const slotOwner = artifacts[autoMemorySlotArtifactIndex]!;
  if (
    !isCanonicalAutoMemoryArtifact(slotOwner, args.framework, args.piSandbox)
  ) {
    return {
      artifacts: withoutSupersededAutoMemoryArtifacts(
        artifacts,
        args.framework,
        args.piSandbox,
        autoMemorySlotArtifactIndex,
      ),
    };
  }

  return {
    artifacts: withCanonicalAutoMemoryMissingRootPolicy(
      artifacts,
      args.framework,
      args.piSandbox,
    ),
  };
}

export function validateRunEnvironmentReferences(args: {
  readonly resolved: ResolvedRunExecution;
  readonly body: CreateRunBody;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly validateEnvironmentReferences: boolean | undefined;
}): CreateRunErrorResult | null {
  const validationSecrets = buildStoredExecutionSecrets({
    connectorContext: args.connectorContext,
    modelProvider: args.modelProvider,
    bodySecrets: args.body.secrets,
    customConnectorContext: args.customConnectorContext,
  });
  const validation = validateCompose(
    args.resolved.content,
    args.body.vars,
    validationSecrets.secrets,
    {
      validateEnvironmentReferences: args.validateEnvironmentReferences,
      environmentSecretPlaceholders:
        args.permissionManifest?.environmentSecretPlaceholders,
      additionalEnvironment: args.modelProvider?.environment,
      storedConnectorEnvironment: args.connectorContext.storedEnvironment,
      connectorVars: args.connectorContext.vars,
    },
  );

  return isRouteError(validation) ? validation : null;
}

function preparedRunAdditionalVolumes(args: {
  readonly createArgs: Pick<CreateAgentRunArgs, "injectSkillVolumes">;
  readonly systemSkillStorageResolution: SystemSkillStorageResolution;
  readonly connectorScope: EffectiveConnectorScope;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly skillsRoot: string;
  readonly body: Pick<CreateRunBody, "additionalVolumes">;
  readonly resolved: Pick<ResolvedRunExecution, "additionalVolumes">;
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
}): PreparedAdditionalVolumes {
  const bodyAdditionalVolumes = args.body.additionalVolumes;
  const injectedSkillVolumes = buildInjectedSkillVolumes(
    {
      injectSkillVolumes: args.createArgs.injectSkillVolumes,
      systemSkillStorageResolution: args.systemSkillStorageResolution,
      allowedConnectorSlugs: args.connectorScope.allowedConnectorSlugs,
      connectorCatalogSelection: args.connectorCatalogSelection,
      officialWorkflowRun: args.officialWorkflowRun,
    },
    args.skillsRoot,
  );
  return mergeAdditionalVolumes({
    prepend: [
      ...buildCustomConnectorSkillVolumes(
        args.customConnectorContext.skills,
        args.skillsRoot,
      ),
      ...(injectedSkillVolumes ?? []),
    ],
    base: prepareAdditionalVolumesWithSource(
      bodyAdditionalVolumes ?? args.resolved.additionalVolumes,
      bodyAdditionalVolumes ? "request_additional_volume" : "unknown",
    ),
  });
}

export interface PreparedRunBodyContext {
  readonly body: CreateRunBody;
  readonly resolved: ResolvedRunExecution;
  readonly connectorScope: EffectiveConnectorScope;
  readonly requestedFramework: SupportedFramework;
  readonly featureSwitchContext: FeatureSwitchContext;
}

export interface PreparedRuntimeContext {
  readonly framework: SupportedFramework;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
  readonly modelUsageLongContextMinTotalInputTokens: number;
  readonly connectorScope: EffectiveConnectorScope;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
}

export function prepareRunOutputMetadata(args: {
  readonly createArgs: Pick<
    CreateAgentRunArgs,
    "injectSkillVolumes" | "pinnedMemoryVersionId"
  >;
  readonly systemSkillStorageResolution: SystemSkillStorageResolution;
  readonly connectorScope: EffectiveConnectorScope;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly framework: SupportedFramework;
  readonly piSandbox: PiModelConfig | undefined;
  readonly body: Pick<CreateRunBody, "additionalVolumes">;
  readonly resolved: RunStorageExecution;
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
}): {
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
  readonly additionalVolumes:
    | readonly AgentRunCreateAdditionalVolume[]
    | undefined;
  readonly additionalVolumeSources: AdditionalVolumeSources;
} {
  const additionalVolumes = preparedRunAdditionalVolumes({
    createArgs: args.createArgs,
    systemSkillStorageResolution: args.systemSkillStorageResolution,
    connectorScope: args.connectorScope,
    connectorCatalogSelection: args.connectorCatalogSelection,
    customConnectorContext: args.customConnectorContext,
    skillsRoot: skillsRootForRun(args.framework, args.piSandbox),
    body: args.body,
    resolved: args.resolved,
    officialWorkflowRun: args.officialWorkflowRun,
  });
  const artifacts = artifactsForRun({
    resolved: args.resolved,
    framework: args.framework,
    piSandbox: args.piSandbox,
    includeAutoMemory: true,
    pinnedMemoryVersionId: args.createArgs.pinnedMemoryVersionId,
  }).artifacts;
  return {
    additionalVolumes: additionalVolumes.volumes,
    additionalVolumeSources: additionalVolumes.sources,
    artifacts,
  };
}

export function isImageRecognitionAvailableForRun(args: {
  readonly includeOkouTokenSecret: boolean | undefined;
  readonly selectedModel: string | undefined;
  readonly providerType: ModelProviderType | undefined;
}): boolean {
  return (
    args.includeOkouTokenSecret === true &&
    getModelImageInputSupport(args.selectedModel, args.providerType) ===
      "unsupported"
  );
}

export interface PrepareRunContextInput {
  readonly db: ReadonlyDb;
  readonly args: CreateAgentRunArgs;
  readonly timing: ApiDispatchTimingCollector;
}

export function resolveCompatibleDirectResumeSession(args: {
  readonly resolved: ResolvedRunExecution;
  readonly next: SessionExecutionIdentity;
}): ResolvedRunExecution {
  const previous = args.resolved.resumeSessionIdentity;
  return previous && canReuseSession(previous, args.next)
    ? args.resolved
    : { ...args.resolved, resumeSession: undefined };
}

export interface RunWorkflowReadInput {
  readonly db: ReadonlyDb;
  readonly args: Pick<
    CreateAgentRunArgs,
    | "catalog"
    | "orgId"
    | "userId"
    | "injectSkillVolumes"
    | "requiredOfficialWorkflowIds"
    | "piExecution"
    | "codexServiceTier"
    | "agentRunMetadata"
  >;
}

export type RunWorkflowModelState =
  | {
      readonly requestedFramework: SupportedFramework;
      readonly modelProvider: ResolvedModelProviderEnvironment | null;
    }
  | CreateRunErrorResult
  | undefined;

export type PreparedOfficialWorkflow =
  | OfficialWorkflowRunObservation
  | CreateRunErrorResult
  | undefined;

export function composePreparedRunContext({
  args,
  bodyContext,
  runtimeContext,
  userTimezone,
  selectedImageModel,
  officialWorkflowRun,
  systemSkillStorageResolution,
  disabledPaidTools,
}: {
  readonly args: CreateAgentRunArgs;
  readonly bodyContext: PreparedRunBodyContext;
  readonly runtimeContext: PreparedRuntimeContext;
  readonly userTimezone: string | undefined;
  readonly selectedImageModel: PreparedRunContext["selectedImageModel"];
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
  readonly systemSkillStorageResolution: SystemSkillStorageResolution;
  readonly disabledPaidTools: readonly string[];
}): PreparedRunContext | CreateRunErrorResult {
  const { body } = bodyContext;
  const piSandbox = resolvePreparedPiModelConfig({
    createArgs: args,
    modelProvider: runtimeContext.modelProvider,
  });
  const resolved = resolveCompatibleDirectResumeSession({
    resolved: bodyContext.resolved,
    next: {
      selectedModel: runtimeContext.modelProvider?.selectedModel ?? null,
      cliAgentType: piSandbox ? "pi" : runtimeContext.framework,
    },
  });
  const validation = validateRunEnvironmentReferences({
    resolved,
    body,
    modelProvider: runtimeContext.modelProvider,
    connectorContext: runtimeContext.connectorContext,
    customConnectorContext: runtimeContext.customConnectorContext,
    permissionManifest: runtimeContext.permissionManifest,
    validateEnvironmentReferences: args.validateEnvironmentReferences,
  });
  if (validation) {
    return validation;
  }
  const metadata = prepareRunOutputMetadata({
    createArgs: args,
    systemSkillStorageResolution: systemSkillStorageResolution,
    connectorScope: runtimeContext.connectorScope,
    connectorCatalogSelection: runtimeContext.connectorCatalogSelection,
    customConnectorContext: runtimeContext.customConnectorContext,
    framework: runtimeContext.framework,
    piSandbox,
    body,
    resolved,
    officialWorkflowRun,
  });
  return {
    disabledPaidTools,
    body,
    resolved,
    framework: runtimeContext.framework,
    piSandbox,
    modelProvider: runtimeContext.modelProvider,
    connectorContext: runtimeContext.connectorContext,
    customConnectorContext: runtimeContext.customConnectorContext,
    permissionManifest: runtimeContext.permissionManifest,
    billableFirewalls: runtimeContext.billableFirewalls,
    modelUsageProvider: runtimeContext.modelUsageProvider,
    modelUsageLongContextMinTotalInputTokens:
      runtimeContext.modelUsageLongContextMinTotalInputTokens,
    connectorScope: runtimeContext.connectorScope,
    ...metadata,
    officialWorkflowRun,
    userTimezone,
    featureSwitchContext: bodyContext.featureSwitchContext,
    selectedImageModel,
    imageRecognitionAvailable: isImageRecognitionAvailableForRun({
      includeOkouTokenSecret: args.includeOkouTokenSecret,
      selectedModel:
        runtimeContext.modelProvider?.selectedModel ??
        args.selectedModelOverride,
      providerType:
        runtimeContext.modelProvider?.concreteType ??
        runtimeContext.modelProvider?.type,
    }),
  };
}

export interface PreparedAgentRun {
  readonly args: CreateAgentRunArgs;
  readonly context: PreparedRunContext;
  readonly contextInput: PrepareRunContextInput;
  readonly timing: ApiDispatchTimingCollector;
  readonly phaseTiming: ApiDispatchPhaseCollector;
}

export function finalizePreparedRunContext(
  prepared: Omit<PreparedAgentRun, "phaseTiming">,
  finalAppendSystemPrompt: CreateRunBody["appendSystemPrompt"],
): FinalizedPreparedRunContext {
  return {
    ...prepared.context,
    launchSnapshot: {
      schemaVersion: 3,
      framework:
        prepared.context.piSandbox === undefined
          ? prepared.context.framework
          : "pi",
      runnerProfile: runnerProfile(prepared.context.resolved.content),
    },
    body: withFinalRunAppendSystemPrompt({
      body: {
        ...prepared.context.body,
        appendSystemPrompt: finalAppendSystemPrompt,
      },
      framework: prepared.context.framework,
      chatThreadId: prepared.args.chatThreadId,
      imageRecognitionAvailable: prepared.context.imageRecognitionAvailable,
      mcpConnectorSlugs: [
        ...prepared.context.connectorContext.mcpConnectorSlugs,
        ...prepared.context.customConnectorContext.mcpConnectorSlugs,
      ],
      selectedImageModel: prepared.context.selectedImageModel,
      cliAvailable: prepared.args.includeOkouTokenSecret === true,
    }),
  };
}
