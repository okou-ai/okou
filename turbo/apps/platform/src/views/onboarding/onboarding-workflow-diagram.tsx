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

/* 34px, not the 64px host: the retired `.owf-diagram-icon-box img` rule was
   unlayered and outranked this image's own size, so this is what the avatar has
   always rendered at. Resizing it is a visual change, not part of this move. */
function WorkflowDiagramOkouAvatar() {
  return (
    <img
      data-slot="onboarding-okou-avatar"
      className="block size-[34px] object-contain"
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

/* Every tile in the illustration shares one outline: the registered
   illustration stroke, the semantic card fill and border, and the artwork's
   own lift. Only radius and size differ between them. */
const DIAGRAM_TILE_CLASS =
  "border-(length:--border-width-illustration) border-solid border-border bg-card shadow-[0_12px_30px_-18px_rgba(0,0,0,0.5)]";

const DIAGRAM_ICON_BOX_CLASS = `inline-flex size-[56px] items-center justify-center overflow-hidden rounded-2xl ${DIAGRAM_TILE_CLASS}`;

const DIAGRAM_STACK_ITEM_CLASS = `absolute inline-flex size-[28px] items-center justify-center rounded-[9px] ${DIAGRAM_TILE_CLASS}`;

/* The stack lays three tiles out by position rather than by flow; the fourth
   slot carries the overflow count. Spelled per index so Tailwind's scanner
   sees each candidate. */
const DIAGRAM_STACK_POSITION_CLASSES = [
  "top-0 left-0",
  "top-0 right-0",
  "bottom-0 left-[7px]",
] as const;

const DIAGRAM_STACK_MORE_CLASS =
  "absolute right-0 bottom-0 inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-full border-(length:--border-width-illustration) border-solid border-[#ffffff] bg-[#29292e] px-[4px] text-[10px] leading-none font-semibold text-[#ffffff]";

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
      <span className={cn(DIAGRAM_ICON_BOX_CLASS, iconClassName)}>
        {children ??
          (visibleConnectorSlugs.length > 1 ? (
            <span className="relative block size-[42px]">
              {visibleConnectorSlugs.map((item, index) => {
                return (
                  <span
                    key={item}
                    className={cn(
                      DIAGRAM_STACK_ITEM_CLASS,
                      DIAGRAM_STACK_POSITION_CLASSES[index],
                    )}
                  >
                    <WorkflowConnectorIcon connectorSlug={item} size={22} />
                  </span>
                );
              })}
              {hiddenConnectorCount > 0 ? (
                <span className={DIAGRAM_STACK_MORE_CLASS}>
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
      iconClassName="size-[72px] p-[4px]"
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

const DIAGRAM_ACTION_CLASS = `absolute z-[5] box-border flex h-[98px] items-center gap-4 overflow-hidden rounded-surface px-6 py-[15px] ${DIAGRAM_TILE_CLASS}`;

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
    <div className={cn(DIAGRAM_ACTION_CLASS, className)}>
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

const DIAGRAM_CANVAS_CLASS =
  "absolute top-0 left-0 h-[470px] w-[614px] min-h-0 origin-top-left scale-[0.6] self-start overflow-hidden rounded-2xl";

/* Waypoint markers on the connector paths. The retired rules resolved their
   coordinates through the canvas variable block; each one is spelled here at
   the value that block produced. The ring is the literal `#ffffff` those rules
   named, not `border-white`: `--color-white` is a theme-flipped token that
   resolves to a near-black in Dark. */
const DIAGRAM_DOT_CLASS =
  "pointer-events-none absolute z-[6] box-border size-[8px] -translate-x-1/2 -translate-y-1/2 rounded-full border-(length:--border-width-illustration-marker) border-solid border-[#ffffff] bg-[#29292e]";

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

function WorkflowDiagramDot({
  className,
  dataSlot,
}: {
  readonly className: string;
  readonly dataSlot?: string;
}) {
  return (
    <span
      data-slot={dataSlot}
      className={cn(DIAGRAM_DOT_CLASS, className)}
      aria-hidden="true"
    />
  );
}

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
          <WorkflowDiagramDot
            dataSlot="onboarding-diagram-source-dot"
            className="top-[81px] left-[166px]"
          />
        ) : null}
        {diagram.destinationConnectorSlug ? (
          <>
            <WorkflowDiagramDot className="top-[81px] left-[455px]" />
            <WorkflowDiagramDot className="top-[112px] left-[485.5px]" />
          </>
        ) : null}
        <WorkflowDiagramDot className="top-[223px] left-[311.5px]" />
        <span className={DIAGRAM_VERTICAL_CONTROL_CLASS} aria-hidden="true" />
        <WorkflowDiagramDot className="top-[322px] left-[312.5px]" />
        <WorkflowDiagramDot className="top-[352px] left-[312.5px]" />
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
          className="top-[224px] left-[142px] w-[339px]"
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
          className="top-[352px] left-[142px] w-[341px]"
        />
      </div>
    </div>
  );
}
