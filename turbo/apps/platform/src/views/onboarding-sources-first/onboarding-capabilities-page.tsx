import { useGet, useLastLoadable, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  ChartLine,
  ChartNoAxesColumnIncreasing,
  Database,
  FileText,
  Handshake,
  ImagePlus,
  ListOrdered,
  MapPin,
  Megaphone,
  Search,
  Share2,
  ShoppingBag,
  Users,
  type LucideIcon,
} from "lucide-react";
import { dataRouterFamilyText } from "@okouai/api-contracts/contracts/data-router-tools";
import { Switch } from "@okouai/ui/components/ui/switch";
import {
  onboardingCapabilityTools$,
  updateOnboardingCapability$,
  type OnboardingCapability,
} from "../../signals/onboarding/onboarding-capabilities.ts";
import { disabledPaidTools$ } from "../../signals/okou-page/paid-tools.ts";
import { authenticatedSessionKey$ } from "../../signals/auth.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";

// Icons are presentation only; an unlisted Router family uses the default.
const CAPABILITY_ICONS: Readonly<Record<string, LucideIcon | undefined>> = {
  "image-generation": ImagePlus,
  "web-search": Search,
  "web-extraction": FileText,
  "company-contacts": Users,
  "website-traffic": ChartLine,
  "keywords-rankings": ListOrdered,
  "ad-creatives": Megaphone,
  "creators-partners": Handshake,
  social: Share2,
  "product-research": ShoppingBag,
  finance: ChartNoAxesColumnIncreasing,
  "places-weather": MapPin,
};

function CapabilityRow({
  tool,
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly tool: OnboardingCapability;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const copy = t(
    ($) => {
      return $.onboarding.sourcesFirst.capabilities.items;
    },
    {
      returnObjects: true,
    },
  );
  const locale = i18n.resolvedLanguage ?? i18n.language;
  // Router owns every family's text, so families can change without an App
  // release; App copy covers only Okou-owned tools.
  const owned = Object.entries(copy).find(([id]) => {
    return id === tool.toolId;
  })?.[1];
  const title =
    "family" in tool
      ? dataRouterFamilyText(tool.family.title, locale, tool.family.id)
      : (owned?.name ?? tool.toolId);
  const description =
    "family" in tool
      ? dataRouterFamilyText(tool.family.description, locale, tool.family.id)
      : (owned?.description ?? "");
  const Icon = CAPABILITY_ICONS[tool.toolId] ?? Database;
  const id = `capability-${tool.toolId}`;

  return (
    <li className="flex items-center gap-4 border-b border-border/60 px-2 py-3.5 last:border-b-0 hover:bg-gray-50">
      <label
        htmlFor={id}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-4"
      >
        <Icon
          size={20}
          className="shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0">
          <span id={`${id}-name`} className="block text-sm font-medium">
            {title}
          </span>
          <span
            id={`${id}-description`}
            className="mt-0.5 block text-xs leading-relaxed text-muted-foreground"
          >
            {description}
          </span>
        </span>
      </label>
      <Switch
        id={id}
        aria-labelledby={`${id}-name`}
        aria-describedby={`${id}-description`}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </li>
  );
}

export function OnboardingCapabilitiesPage() {
  const identity = useGet(authenticatedSessionKey$);
  // Same-member refreshes retain the controls; identity changes discard them.
  return <OnboardingCapabilitiesContent key={identity} />;
}

function OnboardingCapabilitiesContent() {
  const { t } = useTranslation();
  const flow = useSourcesFirstFlow("capabilities");
  const tools = useLoadable(onboardingCapabilityTools$);
  const disabledTools = useLastLoadable(disabledPaidTools$);
  const [save, update] = useLoadableSet(updateOnboardingCapability$);
  const signal = useGet(pageSignal$);
  const pending = save.state === "loading";
  const failed =
    tools.state === "hasError" || disabledTools.state === "hasError";

  return (
    <OnboardingStepLayout
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={t(($) => {
        return $.onboarding.sourcesFirst.capabilities.title;
      })}
      description={t(($) => {
        return $.onboarding.sourcesFirst.capabilities.copy;
      })}
      primaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.continue;
      })}
      primaryBusy={pending}
      onPrimary={flow.goNext}
      onBack={flow.goBack}
    >
      {tools.state === "hasData" && disabledTools.state === "hasData" ? (
        <ul
          aria-label={t(($) => {
            return $.onboarding.sourcesFirst.capabilities.listLabel;
          })}
        >
          {tools.data.map((tool) => {
            return (
              <CapabilityRow
                key={tool.toolId}
                tool={tool}
                checked={!disabledTools.data.includes(tool.toolId)}
                disabled={pending}
                onCheckedChange={(checked) => {
                  detach(update(tool, checked, signal), Reason.DomCallback);
                }}
              />
            );
          })}
        </ul>
      ) : (
        <p
          role={failed ? "alert" : "status"}
          className={
            failed
              ? "text-sm text-destructive"
              : "text-sm text-muted-foreground"
          }
        >
          {t(($) => {
            return failed
              ? $.settings.paidTools.loadError
              : $.settings.paidTools.loading;
          })}
        </p>
      )}
      {save.state === "hasError" && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {t(($) => {
            return $.settings.paidTools.saveError;
          })}
        </p>
      )}
    </OnboardingStepLayout>
  );
}
