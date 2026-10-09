import {
  orgOpenrouterPresetContract,
  type OrgOpenrouterPreset,
} from "@okouai/api-contracts/contracts/org-openrouter-preset";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed, state } from "ccstate";

import { apiClient$ } from "../../api-client.ts";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { isOrgAdmin$ } from "../../org.ts";
import { accept } from "../../../lib/accept.ts";

export const canManageOpenrouterPreset$ = computed(async (get) => {
  const [admin, features] = await Promise.all([
    get(isOrgAdmin$),
    get(featureSwitch$),
  ]);
  return admin && features[FeatureSwitchKey.OkouDebug];
});

const reloadPreset$ = state(0);

export const orgOpenrouterPreset$ = computed(async (get) => {
  get(reloadPreset$);
  if (!(await get(canManageOpenrouterPreset$))) {
    return null;
  }
  const client = get(apiClient$)(orgOpenrouterPresetContract);
  const result = await accept(client.get(), [200]);
  return result.body.openrouterPreset;
});

export const updateOrgOpenrouterPreset$ = command(
  async (
    { get, set },
    openrouterPreset: OrgOpenrouterPreset,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const client = get(apiClient$)(orgOpenrouterPresetContract);
    await accept(
      client.update({ body: { openrouterPreset }, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadPreset$, (value) => {
      return value + 1;
    });
    await get(orgOpenrouterPreset$);
    signal.throwIfAborted();
  },
);
