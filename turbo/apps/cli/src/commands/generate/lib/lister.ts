import chalk from "chalk";
import type {
  ConnectorCatalogItem,
  ConnectorCatalogStatus,
} from "../../../lib/api/domains/connectors";
import { getAgentUserBuiltinConnectors } from "../../../lib/api/domains/agents";
import {
  listConnectorCatalog,
  listConnectorCatalogStatus,
} from "../../../lib/api/domains/connectors";
import { getPlatformOrigin } from "../../../lib/platform-url";
import {
  getGenerationPaidTool,
  getPaidToolUnavailableMessage,
} from "../../../lib/command/paid-tools";
import { getOkouAgentId } from "../../../lib/okou-env";
import { connectorActionUrl } from "../../connector/action-url";
import {
  isRunBoundConnectorContext,
  resolveRunConnectorAccountLookups,
  type RunConnectorAccountLookup,
} from "../../connector/run-account-context";
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODEL_CONFIGS,
} from "@okouai/core/image-model-catalog";
const IMAGE_MODEL_SETTING_SUMMARY = `the image model selected in Settings › Built-in tools (default ${IMAGE_MODEL_CONFIGS[DEFAULT_IMAGE_MODEL].alias})`;

type ConnectorGenerationType = "audio" | "code" | "document" | "image" | "text";

type BuiltInGenerationType =
  | "dashboard-design"
  | "docs-design"
  | "image"
  | "mobile-app-design"
  | "music"
  | "poster"
  | "presentation"
  | "report"
  | "sprite"
  | "website";
export type GenerationType = ConnectorGenerationType | BuiltInGenerationType;

interface BuiltInGenerationCommand {
  label: string;
  command: string;
  description: string;
}

interface GenerationContext {
  readonly lines: readonly string[];
}

const BUILT_IN_GENERATION_COMMANDS: Partial<
  Record<GenerationType, BuiltInGenerationCommand>
> = {
  image: {
    label: "Built-in image generation",
    command: "okou generate image --provider built-in -h",
    description: `Models: Uses ${IMAGE_MODEL_SETTING_SUMMARY}. Available: OpenAI: gpt-image-2.5-flare, gpt-image-2.5-sunburst; fal.ai: gpt-image-1, gpt-image-2, flux-2-pro, ideogram-4, flux-pro-1.1, flux-pro-1.1-ultra, qwen-image-3, seedream4, nano-banana-2, nano-banana-2-lite; BytePlus: seedream5-pro, seedream5-lite`,
  },
  presentation: {
    label: "Built-in presentation generation",
    command: "okou generate presentation -h",
    description: "Returns authoring instructions for the calling agent.",
  },
  report: {
    label: "Built-in report generation",
    command: "okou generate report -h",
    description: "Returns authoring instructions for the calling agent.",
  },
  "docs-design": {
    label: "Built-in docs design generation",
    command: "okou generate docs-design -h",
    description: "Returns authoring instructions for the calling agent.",
  },
  poster: {
    label: "Built-in poster generation",
    command: "okou generate poster -h",
    description: "Returns authoring instructions for the calling agent.",
  },
  "dashboard-design": {
    label: "Built-in dashboard design generation",
    command: "okou generate dashboard-design -h",
    description: "Returns authoring instructions for the calling agent.",
  },
  "mobile-app-design": {
    label: "Built-in mobile app design generation",
    command: "okou generate mobile-app-design -h",
    description: "Returns authoring instructions for the calling agent.",
  },
  website: {
    label: "Built-in website generation",
    command: "okou generate website -h",
    description: "Returns authoring instructions for the calling agent.",
  },
  sprite: {
    label: "Built-in sprite asset generation",
    command: "okou generate sprite -h",
    description: `Models: Built-in image generation with ${IMAGE_MODEL_SETTING_SUMMARY}`,
  },
};

const GENERATION_CONTEXT: Partial<Record<GenerationType, GenerationContext>> = {
  website: {
    lines: [
      "Standalone static website artifacts can be authored locally and published with okou host for a hosted URL.",
      "okou host is for static directories with index.html; it is not a general deploy system for apps that need a backend, database, worker, or long-running process.",
      "Existing web app changes should usually follow the project's own build, test, and deploy workflow.",
    ],
  },
};

const GENERATION_TYPE_LABELS: Record<GenerationType, string> = {
  audio: "Audio",
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
      return generationType;
  }
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

function renderBuiltInCommand(params: {
  generationType: GenerationType;
  unavailableMessage: string | undefined;
}): void {
  const { generationType, unavailableMessage } = params;
  const command = getBuiltInCommand(generationType);
  if (!command) return;

  console.log("");
  console.log("Built-in command:");
  console.log(`  Okou  ${command.label}`);
  console.log(`  ${command.description}`);
  if (unavailableMessage) {
    console.log(`  Availability: ${unavailableMessage}`);
  }
  console.log(`  Use: ${command.command}`);
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
  runBound: boolean;
  unavailableMessage: string | undefined;
}): void {
  const {
    generationType,
    agentId,
    ready,
    other,
    showAll,
    runBound,
    unavailableMessage,
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

  renderBuiltInCommand({
    generationType,
    unavailableMessage,
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
  const paidTool = getGenerationPaidTool(generationType);
  const [catalog, enabledConnectorSlugs, platformOrigin, unavailableMessage] =
    await Promise.all([
      loadGenerationCatalog(connectorGenerationType, runBound),
      agentId ? getAgentUserBuiltinConnectors(agentId) : Promise.resolve(null),
      getPlatformOrigin(),
      paidTool
        ? getPaidToolUnavailableMessage(paidTool)
        : Promise.resolve(undefined),
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
    runBound,
    unavailableMessage,
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
