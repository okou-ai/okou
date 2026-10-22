import chalk from "chalk";
import type { ConnectorCatalogItem } from "../../../lib/api/domains/connectors";
import { getAgentUserBuiltinConnectors } from "../../../lib/api/domains/agents";
import {
  listConnectorCatalog,
  listConnectedConnectors,
} from "../../../lib/api/domains/connectors";
import { getPlatformOrigin } from "../../../lib/platform-url";
import { isPaidToolEnabled } from "../../../lib/command/paid-tools";
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
import {
  getConnectorGenerationType,
  type ConnectorGenerationType,
  type GenerationType,
} from "./generation-type";

const IMAGE_MODEL_SETTING_SUMMARY = `the image model selected in Settings › Built-in tools (default ${IMAGE_MODEL_CONFIGS[DEFAULT_IMAGE_MODEL].alias})`;

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
    description: `Models: Uses ${IMAGE_MODEL_SETTING_SUMMARY}. Available: OpenAI: gpt-image-2.5-flare, gpt-image-2.5-sunburst; fal.ai: gpt-image-1, gpt-image-2, flux-2-pro, ideogram-4, flux-pro-1.1, flux-pro-1.1-ultra, qwen-image-3, seedream4, nano-banana-2, nano-banana-2-lite`,
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
    description: "Returns sprite authoring and postprocessing instructions.",
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
  | "saved-accounts"
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

function getBuiltInCommand(
  generationType: GenerationType,
): BuiltInGenerationCommand | null {
  if (generationType === "image" && !isPaidToolEnabled("image-generation"))
    return null;
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

function toCurrentCandidate(params: {
  connector: ConnectorCatalogItem;
  hasSavedAccounts: boolean;
  platformOrigin: string;
}): GenerationCandidate {
  const { connector, hasSavedAccounts, platformOrigin } = params;
  return {
    connectorSlug: connector.slug,
    label: connector.label,
    status: hasSavedAccounts ? "saved-accounts" : "not-connected",
    reason: hasSavedAccounts
      ? `saved accounts; inspect with okou connector status ${connector.slug}`
      : "no saved accounts",
    actionLabel: hasSavedAccounts
      ? `Manage ${connector.label} accounts`
      : `Connect ${connector.label}`,
    actionUrl: hasSavedAccounts
      ? `${platformOrigin}/connectors`
      : `${platformOrigin}/connectors/${connector.slug}/connect`,
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

function renderBuiltInCommand(generationType: GenerationType): void {
  const command = getBuiltInCommand(generationType);
  if (!command) return;

  console.log("");
  console.log("Built-in command:");
  console.log(`  Okou  ${command.label}`);
  console.log(`  ${command.description}`);
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
}): void {
  const { generationType, agentId, ready, other, showAll, runBound } = params;
  const label = GENERATION_TYPE_LABELS[generationType];
  const scope = runBound ? "for current run" : "(saved-account directory)";

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

  if (!runBound) {
    console.log(
      "Saved accounts may need setup, reconnect, or permission updates. Inspect connector status before use; directory membership does not establish runtime availability or agent authorization.",
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
      console.log(
        runBound
          ? `  No ready ${generationType} generation connectors found.`
          : `  No ${generationType} generation connectors with saved accounts found.`,
      );
    }
  }

  renderBuiltInCommand(generationType);
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
      readonly connectors: readonly ConnectorCatalogItem[];
    }
  | { readonly kind: "none"; readonly connectors: readonly [] };

async function loadGenerationCatalog(
  connectorGenerationType: ConnectorGenerationType | null,
  runBound: boolean,
): Promise<GenerationCatalogSource> {
  if (!connectorGenerationType) {
    return { kind: "none", connectors: [] };
  }
  const { connectors } = await listConnectorCatalog();
  return { kind: runBound ? "run" : "current", connectors };
}

export async function runLister(
  generationType: GenerationType,
  options: ListerOptions = {},
): Promise<void> {
  const connectorGenerationType = getConnectorGenerationType(generationType);
  const agentId = getOkouAgentId();
  const runBound = isRunBoundConnectorContext();
  const [catalog, enabledConnectorSlugs, platformOrigin] = await Promise.all([
    loadGenerationCatalog(connectorGenerationType, runBound),
    agentId ? getAgentUserBuiltinConnectors(agentId) : Promise.resolve(null),
    getPlatformOrigin(),
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
    const connectors = getGenerationConnectors(
      connectorGenerationType,
      catalog.connectors,
    );
    const directory =
      connectors.length > 0 ? await listConnectedConnectors() : null;
    const savedSlugs = new Set(
      directory?.builtinConnectors.map((connector) => {
        return connector.slug;
      }),
    );
    candidates = connectors.map((connector) => {
      return toCurrentCandidate({
        connector,
        hasSavedAccounts: savedSlugs.has(connector.slug),
        platformOrigin,
      });
    });
  }
  const ready = candidates.filter((candidate) => {
    return (
      candidate.status === "ready" || candidate.status === "saved-accounts"
    );
  });
  const other = candidates.filter((candidate) => {
    return (
      candidate.status !== "ready" && candidate.status !== "saved-accounts"
    );
  });
  renderText({
    generationType,
    agentId,
    ready,
    other,
    showAll: options.all === true,
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
