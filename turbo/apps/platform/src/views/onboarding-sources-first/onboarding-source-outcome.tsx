import { FileText, Image, Palette } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { OnboardingIndustry } from "@okouai/core/onboarding-industry";
import { DEFAULT_AGENT_AVATAR_URL } from "@okouai/core/agent-avatar";
import { avatarTextureUrl } from "@okouai/core/agent-avatar-texture";
import { cn } from "@okouai/ui";
import type { PlatformConnectorCatalogConnectItem } from "../../signals/connector-domain.ts";
import { ConnectorIcon } from "../okou-page/components/settings/connector-icons.tsx";
import { OnboardingSourceOutcomeContent } from "./onboarding-source-outcome-content.tsx";
import { useMobileOnboarding } from "../onboarding/use-mobile-onboarding.ts";

function OutcomeSource({
  connector,
  creative,
}: {
  readonly connector: Pick<
    PlatformConnectorCatalogConnectItem,
    "label" | "icon"
  >;
  readonly creative: boolean;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.outcomes.examples.design;
    },
    { returnObjects: true },
  );
  return (
    <div
      className={cn(
        "relative flex min-h-12 w-44 items-center gap-2.5 rounded-[13px] border border-[#24212114] bg-[#ffffff] px-4 py-3 @max-[380px]:w-[172px]",
        creative &&
          "grid min-h-[68px] w-[260px] max-w-full grid-cols-[20px_minmax(0,1fr)] gap-x-2.5 gap-y-[7px] px-3.5 py-[11px] @max-[380px]:w-[260px]",
      )}
    >
      <ConnectorIcon
        icon={{ ...connector.icon, invertInDarkMode: false }}
        size={20}
      />
      <strong className="text-[13px] leading-5 font-medium">
        {connector.label}
      </strong>
      {creative && (
        <div className="col-span-full flex flex-wrap gap-x-3 gap-y-1 text-[10px] leading-4 text-[#788597] @max-[280px]:gap-x-2 @max-[280px]:text-[9px]">
          {(
            [
              [FileText, copy.clientBrief],
              [Palette, copy.brandGuide],
              [Image, copy.photos],
            ] as const
          ).map(([Icon, label]) => {
            return (
              <span
                key={label}
                className="inline-flex items-center gap-1 whitespace-nowrap @max-[280px]:gap-[3px]"
              >
                <Icon
                  aria-hidden="true"
                  className="size-[11px] shrink-0 text-[#94a9c4] @max-[280px]:size-2.5"
                />
                {label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Sample content is independent of account data and never implies a connection. */
function OutcomeFigure({
  industry,
  connector,
}: {
  readonly industry: OnboardingIndustry;
  readonly connector: Pick<
    PlatformConnectorCatalogConnectItem,
    "label" | "icon"
  >;
}) {
  const { t } = useTranslation();
  const creative = industry === "design";
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.outcomes;
    },
    {
      returnObjects: true,
    },
  );
  return (
    <figure
      className="@container min-w-0 wrap-anywhere text-[#242121]"
      aria-label={t(
        ($) => {
          return $.onboarding.sourcesFirst.outcomes.accessibleLabel;
        },
        {
          title: copy.industries[industry].title,
          source: connector.label,
        },
      )}
    >
      <div
        className={cn(
          "relative isolate overflow-hidden rounded-[20px] border border-[#e1eaf4] bg-[#edf3fa] px-6 pt-6 pb-6 @max-[380px]:px-4 @max-[380px]:pt-5",
          creative && "pt-5 pb-4",
        )}
      >
        <img
          src={avatarTextureUrl("drop-lightblue-blue")}
          alt=""
          className="pointer-events-none absolute inset-0 size-full object-cover opacity-[0.08]"
        />
        <OutcomeSource connector={connector} creative={creative} />
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none relative ml-[88px] h-[38px] w-[calc(50%_-_68px)] text-[#9cb5d0] @max-[380px]:ml-[86px] @max-[380px]:h-9 @max-[380px]:w-[calc(50%_-_82px)]",
            creative &&
              "ml-[130px] h-[34px] w-[calc(50%_-_110px)] @max-[380px]:ml-[min(130px,50%)] @max-[380px]:h-[34px] @max-[380px]:w-[max(4px,calc(50%_-_126px))]",
          )}
        >
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            fill="none"
            className="block size-full overflow-visible"
          >
            <path
              d="M0 0 C0 55 100 45 100 100"
              vectorEffect="non-scaling-stroke"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinecap="round"
            />
          </svg>
          <span className="absolute top-0 left-0 size-[5px] -translate-1/2 rounded-full border border-current bg-[#ffffff]" />
          <span className="absolute right-0 bottom-0 size-[5px] translate-1/2 rounded-full border border-[#ffffff] bg-current" />
        </div>
        <div className="relative ml-10 overflow-hidden rounded-[15px] border border-[#24212117] bg-[#ffffff] shadow-[0_2px_8px_rgb(36_33_33/0.03)] @max-[380px]:ml-2">
          <div
            className={cn(
              "flex items-center gap-[9px] px-4 py-3.5 @max-[380px]:px-3.5",
              creative && "pt-3 pb-2.5",
            )}
          >
            <img
              src={DEFAULT_AGENT_AVATAR_URL}
              alt=""
              className="size-[22px] shrink-0 rounded-[7px] bg-[#f9e840] object-cover"
            />
            <strong className="min-w-0 text-[13px] leading-5 font-medium">
              {copy.industries[industry].title}
            </strong>
          </div>
          <div
            className={cn(
              "flex min-h-32 items-center px-4 pb-[18px] @max-[380px]:px-3.5 @max-[280px]:min-h-[146px]",
              creative &&
                "min-h-[130px] pb-4 @max-[380px]:min-h-[142px] @max-[280px]:min-h-[150px]",
            )}
          >
            <div className="w-full">
              <OnboardingSourceOutcomeContent industry={industry} />
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}

export function OnboardingSourceOutcome({
  industry,
  connector,
}: {
  readonly industry: OnboardingIndustry;
  readonly connector: Pick<
    PlatformConnectorCatalogConnectItem,
    "label" | "icon"
  >;
}) {
  const { t } = useTranslation();
  const mobile = useMobileOnboarding();
  const figure = <OutcomeFigure industry={industry} connector={connector} />;
  return mobile ? (
    <details className="mt-4 rounded-xl border border-border px-4 py-3">
      <summary className="cursor-pointer text-sm hover:text-muted-foreground">
        {t(($) => {
          return $.onboarding.sourcesFirst.outcomes.expandLabel;
        })}
      </summary>
      <div className="mt-3">{figure}</div>
    </details>
  ) : (
    <div className="mt-6">{figure}</div>
  );
}
