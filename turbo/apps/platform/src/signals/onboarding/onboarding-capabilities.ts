import { command, computed } from "ccstate";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$, clerk$ } from "../auth.ts";
import { createPaidToolsCatalogSignals } from "../okou-page/settings/paid-tools-catalog.ts";
import {
  createPaidToolsSignals,
  type DataFamilySettings,
  type PaidToolSettings,
} from "../okou-page/settings/paid-tools.ts";

export type OnboardingCapability = PaidToolSettings | DataFamilySettings;

const onboardingCatalog = createPaidToolsCatalogSignals();
export const startOnboardingCapabilitiesDiscovery$ =
  onboardingCatalog.startDiscovery$;

/** The same member preferences as Settings, without requiring an open dialog. */
const onboardingPaidTools$ = computed(async (get) => {
  const identity = get(authenticatedSessionKey$);
  const createClient = get(apiClient$);
  const clerk = await get(clerk$);
  const assertCurrent = () => {
    if (
      !identity ||
      !clerk.user ||
      !clerk.organization ||
      !clerk.session ||
      JSON.stringify([
        clerk.organization.id,
        clerk.user.id,
        clerk.session.id,
      ]) !== identity
    ) {
      throw new DOMException(
        "Onboarding capabilities owner changed",
        "AbortError",
      );
    }
  };
  assertCurrent();
  return createPaidToolsSignals(
    createClient,
    assertCurrent,
    onboardingCatalog.catalog$,
  );
});

const CAPABILITY_ORDER: readonly string[] = [
  "image-generation",
  "social",
  "web-search",
  "people-search",
  "data-search",
  "scrape",
  "finance",
  "maps",
  "seo",
];

export const onboardingCapabilityTools$ = computed(async (get) => {
  const settings = await get(onboardingPaidTools$);
  const families = await get(settings.dataFamilies$);
  const tools: OnboardingCapability[] = [
    settings.imageGeneration,
    settings.webSearch,
    ...families,
  ];
  return tools.sort((a, b) => {
    const aIndex = CAPABILITY_ORDER.indexOf(a.toolId);
    const bIndex = CAPABILITY_ORDER.indexOf(b.toolId);
    return (
      (aIndex === -1 ? CAPABILITY_ORDER.length : aIndex) -
      (bIndex === -1 ? CAPABILITY_ORDER.length : bIndex)
    );
  });
});

/** One page operation disables Continue until the confirmed preference is visible. */
export const updateOnboardingCapability$ = command(
  async (
    { set },
    tool: OnboardingCapability,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(tool.update$, enabled, signal);
  },
);
