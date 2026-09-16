import chalk from "chalk";
import type {
  ConnectorCatalogItem,
  ConnectorCatalogStatus,
} from "../../../lib/api/domains/connectors";
import { getBillingStatus } from "../../../lib/api/domains/billing";
import { getAgentUserConnectors } from "../../../lib/api/domains/agents";
import {
  listConnectorCatalog,
  listConnectorCatalogStatus,
} from "../../../lib/api/domains/connectors";
import { getPlatformOrigin } from "../../../lib/platform-url";
import {
  currentPlanAllowsVideo,
  currentTokenCanReadBilling,
} from "../../shared/billing-capabilities";
import { planUpgradeUrl } from "../../shared/billing-links";
import { getOkouAgentId } from "../../../lib/okou-env";
import { connectorActionUrl } from "../../connector/action-url";
import {
  isRunBoundConnectorContext,
  resolveRunConnectorAccountLookups,
  type RunConnectorAccountLookup,
} from "../../connector/run-account-context";
import {
  DEFAULT_VIDEO_MODEL,
  VIDEO_MODEL_CONFIGS,
  VIDEO_MODELS,
} from "@okouai/core/video-model-catalog";

/**
 * Derived from the catalog so the summary cannot keep marking a model the
 * default after the catalog stops using it.
 */
const BUILT_IN_VIDEO_MODEL_SUMMARY = VIDEO_MODELS.map((model) => {
  const { alias } = VIDEO_MODEL_CONFIGS[model];
  return model === DEFAULT_VIDEO_MODEL ? `${alias} (default)` : alias;
}).join(", ");

type ConnectorGenerationType =
  | "audio"
  | "code"
  | "document"
  | "image"
  | "text"
  | "video";

type BuiltInGenerationType =
  | "avatar-video"
  | "dashboard-design"
  | "docs-design"
  | "image"
  | "mobile-app-design"
  | "music"
  | "poster"
  | "presentation"
  | "report"
  | "sprite"
  | "video"
  | "voice"
  | "website";
export type GenerationType = ConnectorGenerationType | BuiltInGenerationType;

interface BuiltInGenerationProvider {
  label: string;
  model: string;
  command: string;
  reason: string;
}

interface BuiltInGenerationCommand {
  label: string;
  command: string;
  models: string;
}

interface GenerationContext {
  readonly lines: readonly string[];
}

const BUILT_IN_GENERATION_PROVIDERS: Partial<
  Record<GenerationType, readonly BuiltInGenerationProvider[]>
> = {
  image: [
    {
      label: "Built-in fal.ai",
      model: "gpt-image-1",
      command: "okou generate image --provider built-in --model gpt-image-1 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "gpt-image-2",
      command: "okou generate image --provider built-in --model gpt-image-2 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in OpenAI",
      model: "gpt-image-2.5-flare",
      command:
        "okou generate image --provider built-in --model gpt-image-2.5-flare -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in OpenAI",
      model: "gpt-image-2.5-sunburst",
      command:
        "okou generate image --provider built-in --model gpt-image-2.5-sunburst -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/flux-pro/v1.1",
      command:
        "okou generate image --provider built-in --model flux-pro-1.1 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/flux-pro/v1.1-ultra",
      command:
        "okou generate image --provider built-in --model flux-pro-1.1-ultra -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/flux-2-pro",
      command: "okou generate image --provider built-in --model flux-2-pro -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/qwen-image",
      command: "okou generate image --provider built-in --model qwen-image -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "alibaba/qwen-image-3/text-to-image",
      command:
        "okou generate image --provider built-in --model qwen-image-3 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "ideogram/v4",
      command: "okou generate image --provider built-in --model ideogram-4 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/bytedance/seedream/v4/text-to-image",
      command: "okou generate image --provider built-in --model seedream4 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in BytePlus",
      model: "dola-seedream-5-0-pro-260628",
      command:
        "okou generate image --provider built-in --model seedream5-pro -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in BytePlus",
      model: "seedream-5-0-lite-260128",
      command:
        "okou generate image --provider built-in --model seedream5-lite -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/nano-banana-2",
      command:
        "okou generate image --provider built-in --model nano-banana-2 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "google/nano-banana-2-lite",
      command:
        "okou generate image --provider built-in --model nano-banana-2-lite -h",
      reason: "available without connector setup",
    },
  ],
  video: [
    {
      label: "Built-in",
      model: "dreamina-seedance-2-5-260628",
      command:
        "okou generate video --provider built-in --model dreamina-seedance-2.5 -h",
      reason: "availability depends on the current workspace plan",
    },
    {
      label: "Built-in",
      model: "dreamina-seedance-2-0-260128",
      command:
        "okou generate video --provider built-in --model dreamina-seedance-2.0 -h",
      reason: "availability depends on the current workspace plan",
    },
    {
      label: "Built-in",
      model: "dreamina-seedance-2-0-fast-260128",
      command:
        "okou generate video --provider built-in --model dreamina-seedance-2.0-fast -h",
      reason: "availability depends on the current workspace plan",
    },
    {
      label: "Built-in",
      model: "dreamina-seedance-2-0-mini-260615",
      command:
        "okou generate video --provider built-in --model dreamina-seedance-2.0-mini -h",
      reason: "availability depends on the current workspace plan",
    },
    {
      label: "Built-in",
      model: "seedance-1-5-pro-251215",
      command:
        "okou generate video --provider built-in --model seedance-1.5-pro -h",
      reason: "availability depends on the current workspace plan",
    },
    {
      label: "Built-in MiniMax",
      model: "MiniMax-H3",
      command: "okou generate video --provider built-in --model minimax-h3 -h",
      reason: "availability depends on the current workspace plan",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/veo3.1/fast",
      command: "okou generate video --provider built-in --model veo3.1-fast -h",
      reason: "availability depends on the current workspace plan",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/kling-video/v3/4k/text-to-video",
      command: "okou generate video --provider built-in --model kling-v3-4k -h",
      reason: "availability depends on the current workspace plan",
    },
  ],
  voice: [
    {
      label: "Built-in",
      model: "gpt-4o-mini-tts",
      command: "okou generate voice --provider built-in -h",
      reason: "available without connector setup",
    },
  ],
};

const BUILT_IN_GENERATION_COMMANDS: Partial<
  Record<GenerationType, BuiltInGenerationCommand>
> = {
  "avatar-video": {
    label: "Built-in JoggAI talking-avatar video generation",
    command: "okou generate avatar-video --provider built-in -h",
    models: "joggai-talking-avatar",
  },
  image: {
    label: "Built-in image generation",
    command: "okou generate image --provider built-in -h",
    models:
      "OpenAI: gpt-image-2.5-flare, gpt-image-2.5-sunburst; fal.ai: gpt-image-1 (default), gpt-image-2, flux-2-pro, ideogram-4, flux-pro-1.1, flux-pro-1.1-ultra, qwen-image, qwen-image-3, seedream4, nano-banana-2, nano-banana-2-lite; BytePlus: seedream5-pro, seedream5-lite",
  },
  video: {
    label: "Built-in video generation",
    command: "okou generate video --provider built-in -h",
    models: BUILT_IN_VIDEO_MODEL_SUMMARY,
  },
  presentation: {
    label: "Built-in presentation generation",
    command: "okou generate presentation -h",
    models: "gpt-5.5",
  },
  report: {
    label: "Built-in report generation",
    command: "okou generate report -h",
    models: "gpt-5.5",
  },
  "docs-design": {
    label: "Built-in docs design generation",
    command: "okou generate docs-design -h",
    models: "gpt-5.5",
  },
  poster: {
    label: "Built-in poster generation",
    command: "okou generate poster -h",
    models: "gpt-5.5",
  },
  "dashboard-design": {
    label: "Built-in dashboard design generation",
    command: "okou generate dashboard-design -h",
    models: "gpt-5.5",
  },
  "mobile-app-design": {
    label: "Built-in mobile app design generation",
    command: "okou generate mobile-app-design -h",
    models: "gpt-5.5",
  },
  website: {
    label: "Built-in website generation",
    command: "okou generate website -h",
    models: "gpt-5.5",
  },
  sprite: {
    label: "Built-in sprite asset generation",
    command: "okou generate sprite -h",
    models: "gpt-image-2 (recommended) via built-in image generation",
  },
  voice: {
    label: "Built-in voice generation",
    command: "okou generate voice --provider built-in -h",
    models: "gpt-4o-mini-tts",
  },
};

const GENERATION_CONTEXT: Partial<Record<GenerationType, GenerationContext>> = {
  website: {
    lines: [
      "Standalone static website artifacts can be authored locally and published with okou host for a public URL.",
      "okou host is for static directories with index.html; it is not a general deploy system for apps that need a backend, database, worker, or long-running process.",
      "Existing web app changes should usually follow the project's own build, test, and deploy workflow.",
    ],
  },
};

const GENERATION_TYPE_LABELS: Record<GenerationType, string> = {
  audio: "Audio",
  "avatar-video": "Talking-avatar video",
  code: "Code",
  "dashboard-design": "Dashboard design",
  document: "Document",
  "docs-design": "Docs design",
  image: "Image",
  "mobile-app-design": "Mobile app design",
  music: "Music",
  poster: "Poster",
  presentation: "Presentation",
  report: "Report",
  sprite: "Sprite",
  text: "Text",
  video: "Video",
  voice: "Voice",
  website: "Website",
};

type CandidateStatus =
  | "ready"
  | "needs-reconnect"
  | "not-authorized"
  | "not-connected"
  | "unavailable-for-run";

interface ListerOptions {
  all?: boolean;
}

interface GenerationCandidate {
  connectorSlug: string;
  label: string;
  status: CandidateStatus;
  reason: string;
  account?: string;
  authMethod?: string;
  actionLabel?: string;
  actionUrl?: string;
}

function getConnectorGenerationType(
  generationType: GenerationType,
): ConnectorGenerationType | null {
  switch (generationType) {
    case "avatar-video":
      return "video";
    case "voice":
    case "music":
      return "audio";
    case "dashboard-design":
    case "docs-design":
    case "mobile-app-design":
    case "poster":
    case "presentation":
    case "report":
    case "sprite":
    case "website":
      return null;
    case "audio":
    case "code":
    case "document":
    case "image":
    case "text":
    case "video":
      return generationType;
  }
}

function getBuiltInProviders(
  generationType: GenerationType,
): readonly BuiltInGenerationProvider[] {
  return BUILT_IN_GENERATION_PROVIDERS[generationType] ?? [];
}

function getBuiltInCommand(
  generationType: GenerationType,
): BuiltInGenerationCommand | null {
  return BUILT_IN_GENERATION_COMMANDS[generationType] ?? null;
}

function getGenerationContext(
  generationType: GenerationType,
): GenerationContext | null {
  return GENERATION_CONTEXT[generationType] ?? null;
}

function getGenerationConnectors<T extends ConnectorCatalogItem>(
  generationType: ConnectorGenerationType,
  connectors: readonly T[],
): T[] {
  return connectors
    .filter((connector) => {
      return connector.generation.includes(generationType);
    })
    .sort((a, b) => {
      return a.slug.localeCompare(b.slug);
    });
}

function formatAccount(connector: ConnectorCatalogStatus): string | undefined {
  if (connector.connection?.externalUsername) {
    return `@${connector.connection.externalUsername}`;
  }
  if (connector.connection?.externalEmail) {
    return connector.connection.externalEmail;
  }
  return undefined;
}

function getCurrentAction(
  status: CandidateStatus,
  connectorSlug: string,
  label: string,
  agentId: string | undefined,
  platformOrigin: string,
): { actionLabel?: string; actionUrl?: string } {
  if (status === "needs-reconnect") {
    return {
      actionLabel: `Reconnect ${label}`,
      actionUrl: `${platformOrigin}/connectors`,
    };
  }

  if (status === "not-authorized" && agentId) {
    return {
      actionLabel: `Authorize ${label}`,
      actionUrl: `${platformOrigin}/connectors/${connectorSlug}/authorize?agentId=${agentId}`,
    };
  }

  if (status === "not-connected") {
    if (agentId) {
      return {
        actionLabel: `Connect and authorize ${label}`,
        actionUrl: `${platformOrigin}/connectors/${connectorSlug}/connect?agentId=${agentId}`,
      };
    }

    return {
      actionLabel: `Connect ${label}`,
      actionUrl: `${platformOrigin}/connectors/${connectorSlug}/connect`,
    };
  }

  return {};
}

function toCurrentCandidate(params: {
  connector: ConnectorCatalogStatus;
  authorizedConnectorSlugs: Set<string> | null;
  agentId: string | undefined;
  platformOrigin: string;
}): GenerationCandidate {
  const { connector, authorizedConnectorSlugs, agentId, platformOrigin } =
    params;
  const connectorSlug = connector.slug;

  let status: CandidateStatus;
  let reason: string;

  if (connector.connectionStatus === "reconnect-required") {
    status = "needs-reconnect";
    reason = "connected, reconnect required";
  } else if (!connector.connected) {
    status = "not-connected";
    reason = agentId
      ? "not connected or authorized for current agent"
      : "not connected";
  } else if (
    authorizedConnectorSlugs &&
    !authorizedConnectorSlugs.has(connectorSlug)
  ) {
    status = "not-authorized";
    reason = "connected, not authorized for current agent";
  } else {
    status = "ready";
    reason = agentId
      ? "connected and authorized for current agent"
      : "connected; agent authorization was not checked";
  }

  return {
    connectorSlug,
    label: connector.label,
    status,
    reason,
    account: connector.connected ? formatAccount(connector) : undefined,
    authMethod: connector.connection?.authMethod,
    ...getCurrentAction(
      status,
      connectorSlug,
      connector.label,
      agentId,
      platformOrigin,
    ),
  };
}

type RunUnavailableAccountLookup = Exclude<
  RunConnectorAccountLookup,
  { readonly state: "available" }
>;

function runUnavailableReason(lookup: RunUnavailableAccountLookup): string {
  switch (lookup.state) {
    case "context-unavailable":
      return "run account context unavailable; start a new run";
    case "not-admitted":
      return "not admitted for this run; change the thread selection and start a new run";
    case "metadata-unavailable":
      return `selected account ${lookup.connectionId} metadata unavailable or deleted; select an account and start a new run`;
  }
}

function toRunCandidate(params: {
  connector: ConnectorCatalogItem;
  lookup: RunConnectorAccountLookup;
  authorizedConnectorSlugs: Set<string> | null;
  agentId: string | undefined;
  platformOrigin: string;
}): GenerationCandidate {
  const {
    connector,
    lookup,
    authorizedConnectorSlugs,
    agentId,
    platformOrigin,
  } = params;
  if (lookup.state !== "available") {
    return {
      connectorSlug: connector.slug,
      label: connector.label,
      status: "unavailable-for-run",
      reason: runUnavailableReason(lookup),
    };
  }

  const needsReconnect =
    lookup.metadata.connectionStatus === "reconnect-required";
  const authorized =
    authorizedConnectorSlugs === null ||
    authorizedConnectorSlugs.has(connector.slug);
  const status: CandidateStatus = needsReconnect
    ? "needs-reconnect"
    : authorized
      ? "ready"
      : "not-authorized";
  const reason = needsReconnect
    ? "connected, reconnect required"
    : authorized
      ? "connected and authorized for current agent"
      : "connected, not authorized for current agent";
  const action = needsReconnect
    ? {
        actionLabel: `Reconnect ${connector.label}`,
        actionUrl: connectorActionUrl({
          origin: platformOrigin,
          path: `/connectors/${connector.slug}/reconnect/${lookup.connectionId}`,
          agentId,
        }),
      }
    : status === "not-authorized" && agentId
      ? {
          actionLabel: `Authorize ${connector.label}`,
          actionUrl: connectorActionUrl({
            origin: platformOrigin,
            path: `/connectors/${connector.slug}/authorize`,
            agentId,
          }),
        }
      : {};

  return {
    connectorSlug: connector.slug,
    label: connector.label,
    status,
    reason,
    account: lookup.label,
    authMethod: lookup.metadata.authMethod,
    ...action,
  };
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function renderRows(candidates: GenerationCandidate[]): void {
  const connectorSlugWidth = Math.max(
    4,
    ...candidates.map((candidate) => {
      return candidate.connectorSlug.length;
    }),
  );
  const labelWidth = Math.max(
    5,
    ...candidates.map((candidate) => {
      return candidate.label.length;
    }),
  );

  for (const candidate of candidates) {
    const suffix =
      candidate.status === "ready"
        ? (candidate.account ?? candidate.authMethod ?? "")
        : candidate.reason;
    console.log(
      `  ${pad(candidate.connectorSlug, connectorSlugWidth)}  ${pad(candidate.label, labelWidth)}  ${suffix}`,
    );
  }
}

function renderActions(
  candidates: GenerationCandidate[],
  runBound: boolean,
): void {
  const actionable = candidates.filter((candidate) => {
    return candidate.actionLabel && candidate.actionUrl;
  });
  if (actionable.length === 0) return;

  console.log("");
  console.log("Next actions:");
  for (const candidate of actionable) {
    console.log(`  [${candidate.actionLabel}](${candidate.actionUrl})`);
  }
  if (runBound) {
    console.log("");
    console.log(
      "After completing connector or authorization changes, start a new run.",
    );
  }
}

function renderBuiltInProvider(params: {
  generationType: GenerationType;
  videoGenerationAllowed: boolean | undefined;
  platformOrigin: string;
}): void {
  const { generationType, videoGenerationAllowed, platformOrigin } = params;
  const command = getBuiltInCommand(generationType);
  if (command) {
    console.log("");
    console.log("Built-in command:");
    console.log(`  Okou  ${command.label}`);
    console.log(`  Models: ${command.models}`);
    if (generationType === "video" || generationType === "avatar-video") {
      if (videoGenerationAllowed === false) {
        console.log(
          "  Availability: Requires a Pro, Team, or Custom workspace plan.",
        );
        console.log(
          `  Upgrade: [Compare plans](${planUpgradeUrl(platformOrigin)})`,
        );
      } else if (videoGenerationAllowed === true) {
        console.log(
          "  Availability: Available on the current plan without connector setup.",
        );
      } else {
        console.log(
          "  Availability: Plan eligibility will be checked before generation.",
        );
      }
    }
    console.log(`  Use: ${command.command}`);
    return;
  }

  const providers = getBuiltInProviders(generationType);
  if (providers.length === 0) return;

  console.log("");
  console.log(
    providers.length === 1 ? "Built-in provider:" : "Built-in providers:",
  );
  for (const provider of providers) {
    console.log(`  Okou  ${provider.label}  Model: ${provider.model}`);
    console.log(`  Use: ${provider.command}`);
  }
}

function renderGenerationContext(generationType: GenerationType): void {
  const context = getGenerationContext(generationType);
  if (!context) return;

  console.log("");
  console.log("Context:");
  for (const line of context.lines) {
    console.log(`  - ${line}`);
  }
}

function renderText(params: {
  generationType: GenerationType;
  agentId: string | undefined;
  ready: GenerationCandidate[];
  other: GenerationCandidate[];
  showAll: boolean;
  videoGenerationAllowed: boolean | undefined;
  platformOrigin: string;
  runBound: boolean;
}): void {
  const {
    generationType,
    agentId,
    ready,
    other,
    showAll,
    videoGenerationAllowed,
    platformOrigin,
    runBound,
  } = params;
  const label = GENERATION_TYPE_LABELS[generationType];
  const scope = agentId ? "for current agent" : "(connected connectors)";

  console.log(`${label} generation choices ${scope}`);
  console.log("");

  if (agentId) {
    console.log(`${"Agent:".padEnd(10)}${agentId}`);
    console.log("");
  } else {
    console.log(
      "OKOU_AGENT_ID is not set, so agent authorization could not be checked.",
    );
    console.log("");
  }

  const hasBuiltInCommand = getBuiltInCommand(generationType) !== null;
  const showConnectorSummary =
    ready.length > 0 || !hasBuiltInCommand || showAll;
  if (showConnectorSummary) {
    console.log("Connectors:");
    if (ready.length > 0) {
      renderRows(ready);
    } else {
      console.log(`  No ready ${generationType} generation connectors found.`);
    }
  }

  renderBuiltInProvider({
    generationType,
    videoGenerationAllowed,
    platformOrigin,
  });
  renderGenerationContext(generationType);

  if (showAll && other.length > 0) {
    console.log("");
    console.log(`Other ${generationType} generation connectors`);
    console.log("");
    renderRows(other);
  }

  if (showAll) {
    renderActions(other, runBound);
  }
}

type GenerationCatalogSource =
  | {
      readonly kind: "run";
      readonly connectors: readonly ConnectorCatalogItem[];
    }
  | {
      readonly kind: "current";
      readonly connectors: readonly ConnectorCatalogStatus[];
    }
  | { readonly kind: "none"; readonly connectors: readonly [] };

async function loadGenerationCatalog(
  connectorGenerationType: ConnectorGenerationType | null,
  runBound: boolean,
): Promise<GenerationCatalogSource> {
  if (!connectorGenerationType) {
    return { kind: "none", connectors: [] };
  }
  if (runBound) {
    const { connectors } = await listConnectorCatalog();
    return { kind: "run", connectors };
  }
  const { connectors } = await listConnectorCatalogStatus();
  return { kind: "current", connectors };
}

export async function runLister(
  generationType: GenerationType,
  options: ListerOptions = {},
): Promise<void> {
  const connectorGenerationType = getConnectorGenerationType(generationType);
  const agentId = getOkouAgentId();
  const runBound = isRunBoundConnectorContext();
  const [catalog, enabledConnectorSlugs, platformOrigin, billing] =
    await Promise.all([
      loadGenerationCatalog(connectorGenerationType, runBound),
      agentId ? getAgentUserConnectors(agentId) : Promise.resolve(null),
      getPlatformOrigin(),
      (generationType === "video" || generationType === "avatar-video") &&
      currentTokenCanReadBilling()
        ? getBillingStatus()
        : Promise.resolve(null),
    ]);
  const authorizedConnectorSlugs = enabledConnectorSlugs
    ? new Set(enabledConnectorSlugs)
    : null;
  let candidates: GenerationCandidate[] = [];
  if (connectorGenerationType && catalog.kind === "run") {
    const connectors = getGenerationConnectors(
      connectorGenerationType,
      catalog.connectors,
    );
    const lookups = await resolveRunConnectorAccountLookups(
      connectors.map((connector) => {
        return { kind: "builtin", connectorSlug: connector.slug };
      }),
    );
    candidates = connectors.map((connector, index) => {
      const lookup = lookups[index];
      if (!lookup) {
        throw new Error("Missing run account lookup for generation connector");
      }
      return toRunCandidate({
        connector,
        lookup,
        authorizedConnectorSlugs,
        agentId,
        platformOrigin,
      });
    });
  } else if (connectorGenerationType && catalog.kind === "current") {
    candidates = getGenerationConnectors(
      connectorGenerationType,
      catalog.connectors,
    ).map((connector) => {
      return toCurrentCandidate({
        connector,
        authorizedConnectorSlugs,
        agentId,
        platformOrigin,
      });
    });
  }
  const ready = candidates.filter((candidate) => {
    return candidate.status === "ready";
  });
  const other = candidates.filter((candidate) => {
    return candidate.status !== "ready";
  });
  renderText({
    generationType,
    agentId,
    ready,
    other,
    showAll: options.all === true,
    videoGenerationAllowed: billing
      ? currentPlanAllowsVideo(billing)
      : undefined,
    platformOrigin,
    runBound,
  });

  const shouldShowOtherHint =
    !options.all &&
    other.length > 0 &&
    (ready.length > 0 || getBuiltInCommand(generationType) === null);
  if (shouldShowOtherHint) {
    console.log("");
    console.log(
      chalk.dim(
        `Use --all to see every ${generationType} generation candidate.`,
      ),
    );
  }
}
