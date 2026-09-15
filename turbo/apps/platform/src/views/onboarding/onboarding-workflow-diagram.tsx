import type { CSSProperties, ReactNode } from "react";
import { useLastLoadable } from "ccstate-react";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type { OnboardingWorkflow } from "./onboarding-data.ts";
import { connectorCatalogStatusBySlug$ } from "../../signals/external/connectors.ts";
import { ConnectorIcon } from "../okou-page/components/settings/connector-icons.tsx";
import { platformStaticAssetUrl } from "../../lib/static-assets.ts";

const OKOU_AVATAR_IMG = platformStaticAssetUrl(
  "views/onboarding/assets/okou-avatar-2df72642115f.webp",
);

function WorkflowDiagramOkouAvatar() {
  return (
    <img
      data-slot="onboarding-okou-avatar"
      className="block size-full object-contain"
      src={OKOU_AVATAR_IMG}
      alt=""
      aria-hidden
    />
  );
}

export function WorkflowConnectorIcon({
  connectorSlug,
  size,
}: {
  readonly connectorSlug: ConnectorSlug;
  readonly size: number;
}) {
  const catalogBySlugLoadable = useLastLoadable(connectorCatalogStatusBySlug$);
  const icon =
    catalogBySlugLoadable.state === "hasData"
      ? catalogBySlugLoadable.data.get(connectorSlug)?.icon
      : undefined;
  return <ConnectorIcon icon={icon} size={size} />;
}

const CONNECTOR_LABELS: Readonly<Record<string, string>> = {
  langfuse: "Langfuse",
  productlane: "Productlane",
  typeform: "Typeform",
  posthog: "PostHog",
  plausible: "Plausible",
  cloudflare: "Cloudflare",
  clerk: "Clerk",
  snowflake: "Snowflake",
  ahrefs: "Ahrefs",
  strapi: "Strapi",
  buffer: "Buffer",
  mailchimp: "Mailchimp",
  "google-ads": "Google Ads",
  "google-analytics": "Google Analytics",
  "google-cloud": "Google Cloud",
  "meta-ads": "Meta Ads",
  exa: "Exa",
  apollo: "Apollo",
  instantly: "Instantly",
  resend: "Resend",
  stripe: "Stripe",
  deel: "Deel",
  "cal-com": "Cal.com",
  todoist: "Todoist",
  reddit: "Reddit",
  gamma: "Gamma",
  figma: "Figma",
  gong: "Gong",
  "google-docs": "Docs",
  sentry: "Sentry",
  slack: "Slack",
  github: "GitHub",
  notion: "Notion",
  vercel: "Vercel",
  axiom: "Axiom",
  asana: "Asana",
  clickup: "ClickUp",
  monday: "Monday",
  heygen: "HeyGen",
  elevenlabs: "ElevenLabs",
  metabase: "Metabase",
  linear: "Linear",
  revenuecat: "RevenueCat",
  "google-sheets": "Sheets",
  hubspot: "HubSpot",
  jira: "Jira",
  firecrawl: "Firecrawl",
  serpapi: "SerpAPI",
  youtube: "YouTube",
  x: "X",
  gmail: "Gmail",
  "google-calendar": "Calendar",
  "google-drive": "Drive",
  "google-forms": "Google Forms",
  "google-meet": "Google Meet",
  "google-search-console": "Search Console",
  quickbooks: "QuickBooks",
  xero: "Xero",
  similarweb: "SimilarWeb",
  salesforce: "Salesforce",
  streak: "Streak",
  airtable: "Airtable",
  calendly: "Calendly",
  intercom: "Intercom",
  zendesk: "Zendesk",
  chatwoot: "Chatwoot",
  fireflies: "Fireflies",
  tldv: "tl;dv",
};

function connectorLabel(connectorSlug: ConnectorSlug): string {
  return CONNECTOR_LABELS[connectorSlug] ?? connectorSlug;
}

const WORKFLOW_SOURCE_CONNECTOR_SLUGS: ReadonlySet<ConnectorSlug> = new Set([
  "apollo",
  "axiom",
  "gmail",
  "google-calendar",
  "google-drive",
  "linear",
  "plausible",
  "sentry",
  "slack",
  "x",
]);

const WORKFLOW_OUTPUT_CONNECTOR_SLUGS: ReadonlySet<ConnectorSlug> = new Set([
  "elevenlabs",
  "gamma",
  "github",
  "gmail",
  "heygen",
  "linear",
  "notion",
  "resend",
  "slack",
  "strapi",
  "v0",
  "vercel",
]);

const WORKFLOW_DELIVERY_CONNECTOR_SLUGS: ReadonlySet<ConnectorSlug> = new Set([
  "slack",
  "gmail",
  "resend",
  "github",
  "linear",
  "notion",
  "strapi",
  "vercel",
  "v0",
  "gamma",
  "heygen",
]);

function uniqueWorkflowConnectorSlugs(
  connectorSlugs: readonly ConnectorSlug[],
): readonly ConnectorSlug[] {
  const seen = new Set<ConnectorSlug>();
  return connectorSlugs.filter((connectorSlug) => {
    if (seen.has(connectorSlug)) {
      return false;
    }
    seen.add(connectorSlug);
    return true;
  });
}

interface WorkflowDiagramModel {
  readonly sourceConnectorSlugs: readonly ConnectorSlug[];
  readonly sourceLabel: string;
  readonly destinationConnectorSlug: ConnectorSlug | undefined;
}

function buildWorkflowDiagramModel(
  workflow: OnboardingWorkflow,
  sourceFallback: string,
): WorkflowDiagramModel {
  const allConnectorSlugs = uniqueWorkflowConnectorSlugs(
    workflow.connectorSlugs,
  );
  const sourceCandidates = uniqueWorkflowConnectorSlugs([
    ...allConnectorSlugs.filter((connectorSlug) => {
      return WORKFLOW_SOURCE_CONNECTOR_SLUGS.has(connectorSlug);
    }),
    ...allConnectorSlugs,
  ]);
  const outputCandidates = uniqueWorkflowConnectorSlugs([
    ...allConnectorSlugs.filter((connectorSlug) => {
      return WORKFLOW_OUTPUT_CONNECTOR_SLUGS.has(connectorSlug);
    }),
    ...allConnectorSlugs,
  ]);

  const primarySource = sourceCandidates[0] ?? allConnectorSlugs[0];
  const destinationConnectorSlug =
    outputCandidates.find((connectorSlug) => {
      return (
        connectorSlug !== primarySource &&
        WORKFLOW_DELIVERY_CONNECTOR_SLUGS.has(connectorSlug)
      );
    }) ??
    outputCandidates.find((connectorSlug) => {
      return connectorSlug !== primarySource;
    }) ??
    undefined;
  const sourceConnectorSlugs = uniqueWorkflowConnectorSlugs([
    ...(primarySource ? [primarySource] : []),
    ...allConnectorSlugs.filter((connectorSlug) => {
      return connectorSlug !== destinationConnectorSlug;
    }),
  ]);
  const primaryLabel = sourceConnectorSlugs[0]
    ? connectorLabel(sourceConnectorSlugs[0])
    : sourceFallback;
  const sourceLabel =
    sourceConnectorSlugs.length > 1
      ? `${primaryLabel} + ${sourceConnectorSlugs.length - 1}`
      : sourceConnectorSlugs[0]
        ? connectorLabel(sourceConnectorSlugs[0])
        : "";

  return {
    sourceConnectorSlugs,
    sourceLabel,
    destinationConnectorSlug,
  };
}

const DIAGRAM_NODE_CLASS =
  "absolute z-[5] flex w-[94px] flex-col items-center gap-[5px] text-center text-xs font-medium text-foreground";

function WorkflowDiagramNode({
  label,
  connectorSlug,
  connectorSlugs,
  className,
  iconClassName,
  dataSlot,
  children,
}: {
  readonly label: string;
  readonly connectorSlug?: ConnectorSlug;
  readonly connectorSlugs?: readonly ConnectorSlug[];
  readonly className: string;
  readonly iconClassName?: string;
  readonly dataSlot?: string;
  readonly children?: ReactNode;
}) {
  const visibleConnectorSlugs = connectorSlugs?.slice(0, 3) ?? [];
  const hiddenConnectorCount = Math.max((connectorSlugs?.length ?? 0) - 3, 0);

  return (
    <div data-slot={dataSlot} className={cn(DIAGRAM_NODE_CLASS, className)}>
      {label ? <span>{label}</span> : null}
      <span className={`owf-diagram-icon-box ${iconClassName ?? ""}`}>
        {children ??
          (visibleConnectorSlugs.length > 1 ? (
            <span className="relative block size-[42px]">
              {visibleConnectorSlugs.map((item) => {
                return (
                  <span key={item} className="owf-diagram-icon-stack-item">
                    <WorkflowConnectorIcon connectorSlug={item} size={22} />
                  </span>
                );
              })}
              {hiddenConnectorCount > 0 ? (
                <span className="owf-diagram-icon-stack-more">
                  +{hiddenConnectorCount}
                </span>
              ) : null}
            </span>
          ) : connectorSlug ? (
            <WorkflowConnectorIcon connectorSlug={connectorSlug} size={34} />
          ) : null)}
      </span>
    </div>
  );
}

function WorkflowDiagramOkouNode() {
  return (
    <WorkflowDiagramNode
      label=""
      className="top-[45px] left-[277px] w-[72px]"
      iconClassName="owf-diagram-avatar"
    >
      <span
        className="relative inline-block size-[64px] overflow-hidden"
        aria-hidden="true"
      >
        <WorkflowDiagramOkouAvatar />
      </span>
    </WorkflowDiagramNode>
  );
}

function WorkflowDiagramAction({
  title,
  description,
  className,
}: {
  readonly title: string;
  readonly description: string;
  readonly className: string;
}) {
  return (
    <div className={`owf-diagram-action ${className}`}>
      <span className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden">
        <strong className="block truncate text-base font-medium text-foreground">
          {title}
        </strong>
        <span className="line-clamp-2 text-sm text-ellipsis text-muted-foreground">
          {description}
        </span>
      </span>
    </div>
  );
}

/* The canvas keeps `owf-diagram` only as the carrier of the shared coordinate
   variables its remaining tile and dot rules read; the class contributes no
   geometry of its own. */
const DIAGRAM_CANVAS_CLASS =
  "owf-diagram absolute top-0 left-0 h-[470px] w-[614px] min-h-0 origin-top-left scale-[0.6] self-start overflow-hidden rounded-2xl";

const DIAGRAM_GRID_CLASS =
  "absolute top-[13px] right-[17px] bottom-[12px] left-[16px] opacity-80 [background-image:radial-gradient(hsl(var(--gray-500)/0.55)_1.5px,transparent_1.5px)] [background-size:34px_34px]";

const DIAGRAM_LINES_CLASS =
  "pointer-events-none absolute inset-0 z-[1] size-full [&_path]:stroke-[#ed7a44] [&_path]:[stroke-width:2] [&_path]:[stroke-linecap:round] [&_path]:[stroke-linejoin:round]";

/* The gradient and both drop shadows keep their literal values: Tailwind's
   gradient utilities interpolate in oklab and would not reproduce them. Reduced
   motion keeps the resting 0.35 opacity, so the animation and the brighter
   opacity are both `motion-safe:`. */
const DIAGRAM_BEAM_CLASS =
  "pointer-events-none absolute top-0 left-0 z-[4] h-[6px] w-[42px] rounded-full opacity-[0.35] [background-image:linear-gradient(90deg,transparent_0%,rgba(255,255,255,0.1)_24%,rgba(255,255,255,0.78)_52%,rgba(255,255,255,0.16)_78%,transparent_100%)] [filter:drop-shadow(0_0_4px_rgba(255,255,255,0.75))_drop-shadow(0_0_8px_rgba(255,255,255,0.35))] [offset-anchor:center] [offset-distance:0%] [offset-rotate:auto] motion-safe:animate-owf-beam-flow motion-safe:opacity-[0.92]";

const DIAGRAM_VERTICAL_CONTROL_CLASS =
  "pointer-events-none absolute top-[322px] left-[312.5px] z-[3] h-[30px] w-0 before:absolute before:top-[4px] before:bottom-[4px] before:left-[-1px] before:w-[2px] before:rounded-full before:bg-[#ed7a44] before:content-['']";

export function WorkflowPreviewDiagram({
  workflow,
}: {
  readonly workflow: OnboardingWorkflow;
}) {
  const { t } = useTranslation();
  const diagram = buildWorkflowDiagramModel(
    workflow,
    t(($) => {
      return $.onboarding.workflowDiagram.source;
    }),
  );
  const firstStep = workflow.detailSteps[1] ?? workflow.detailSteps[0];
  const lastStep = workflow.detailSteps.at(-1) ?? firstStep;
  const hasSource = diagram.sourceConnectorSlugs.length > 0;
  const destinationCurvePath =
    "M485 112V148.65C485 166.79 469.17 175.85 437.51 175.85H352.59C325.19 175.85 311.5 183.7 311.5 199.4V223";
  const beamPath = hasSource
    ? diagram.destinationConnectorSlug
      ? "M170 81H485V148.65C485 166.79 469.17 175.85 437.51 175.85H352.59C325.19 175.85 311.5 183.7 311.5 199.4V356"
      : "M170 81H311.5V223H312.5V356"
    : "M311.5 112V356";

  return (
    <div className="relative mx-auto h-[282px] w-[368.4px] max-w-full">
      <div className={DIAGRAM_CANVAS_CLASS}>
        <div className={DIAGRAM_GRID_CLASS} aria-hidden="true" />
        <svg
          className={DIAGRAM_LINES_CLASS}
          viewBox="0 0 614 470"
          fill="none"
          aria-hidden="true"
        >
          {hasSource ? <path d="M170 81H277" /> : null}
          {diagram.destinationConnectorSlug ? (
            <>
              <path d="M349 81H451" />
              <path d={destinationCurvePath} />
            </>
          ) : (
            <path d="M311.5 112V223" />
          )}
        </svg>
        <span
          className={DIAGRAM_BEAM_CLASS}
          aria-hidden="true"
          style={{ offsetPath: `path("${beamPath}")` } satisfies CSSProperties}
        />
        {hasSource ? (
          <span
            data-slot="onboarding-diagram-source-dot"
            className="owf-diagram-dot-source"
            aria-hidden="true"
          />
        ) : null}
        {diagram.destinationConnectorSlug ? (
          <>
            <span
              className="owf-diagram-dot-destination-in"
              aria-hidden="true"
            />
            <span
              className="owf-diagram-dot-destination-down"
              aria-hidden="true"
            />
          </>
        ) : null}
        <span className="owf-diagram-dot-action-top" aria-hidden="true" />
        <span className={DIAGRAM_VERTICAL_CONTROL_CLASS} aria-hidden="true" />
        <span className="owf-diagram-dot-action-middle" aria-hidden="true" />
        <span className="owf-diagram-dot-action-bottom" aria-hidden="true" />
        {diagram.sourceConnectorSlugs.length > 0 ? (
          <WorkflowDiagramNode
            label={diagram.sourceLabel}
            connectorSlug={diagram.sourceConnectorSlugs[0]}
            connectorSlugs={diagram.sourceConnectorSlugs}
            dataSlot="onboarding-diagram-source-node"
            className="top-[34px] left-[94px] w-[82px]"
          />
        ) : null}
        <WorkflowDiagramOkouNode />
        {diagram.destinationConnectorSlug ? (
          <WorkflowDiagramNode
            label={connectorLabel(diagram.destinationConnectorSlug)}
            connectorSlug={diagram.destinationConnectorSlug}
            className="top-[32px] left-[455px] w-[61px]"
          />
        ) : null}
        <WorkflowDiagramAction
          title={
            firstStep?.title ??
            t(($) => {
              return $.onboarding.workflowDiagram.preparedTitle;
            })
          }
          description={
            firstStep?.description ??
            t(($) => {
              return $.onboarding.workflowDiagram.preparedDescription;
            })
          }
          className="owf-diagram-action-one"
        />
        <WorkflowDiagramAction
          title={
            lastStep?.title ??
            t(($) => {
              return $.onboarding.workflowDiagram.reviewTitle;
            })
          }
          description={
            lastStep?.description ??
            t(($) => {
              return $.onboarding.workflowDiagram.reviewDescription;
            })
          }
          className="owf-diagram-action-two"
        />
      </div>
    </div>
  );
}
