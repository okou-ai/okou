import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";
import { openSettingsBillingPlansDialog$ } from "../okou-page/settings/settings-dialog.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";

export interface PlanUpgradeDescriptor {
  readonly href: string;
}

export interface PlanUpgradeSignals extends PlanUpgradeDescriptor {
  readonly open$: typeof openSettingsBillingPlansDialog$;
}

type PlanUpgradeCardSignalsRegistry = CardSignalsRegistry<
  PlanUpgradeDescriptor,
  PlanUpgradeSignals
>;

export function parsePlanUpgradeUrl(
  value: string,
): PlanUpgradeDescriptor | null {
  const url = parseTrustedPlatformActionUrl(value);
  if (
    !url ||
    url.pathname !== "/" ||
    url.searchParams.get("settings") !== "billing" ||
    url.searchParams.get("billingView") !== "plans"
  ) {
    return null;
  }

  return {
    href: "/?settings=billing&billingView=plans",
  };
}

export function createPlanUpgradeCardSignalsRegistry(): PlanUpgradeCardSignalsRegistry {
  return createCardSignalsRegistry(
    (descriptor: PlanUpgradeDescriptor) => {
      return descriptor.href;
    },
    (descriptor) => {
      return {
        ...descriptor,
        open$: openSettingsBillingPlansDialog$,
      };
    },
  );
}
