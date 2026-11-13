import { command } from "ccstate";

import { detachedNavigateTo$, searchParams$ } from "../../route.ts";
import { ROUTES } from "../../route-paths.ts";
import type { SettingsSection } from "./settings-dialog.ts";

function sectionForLegacyTab(tab: string | null): SettingsSection {
  if (tab === "model-configuration" || tab === "personal-providers") {
    return "model";
  }
  if (tab === "debug") {
    return "debug";
  }
  return "preference";
}

export const setupLegacySettingsRedirect$ = command(({ get, set }) => {
  const current = get(searchParams$);
  const next = new URLSearchParams({
    settings: sectionForLegacyTab(current.get("tab")),
  });
  for (const [name, value] of current) {
    if (name !== "tab" && name !== "settings") {
      next.append(name, value);
    }
  }
  set(detachedNavigateTo$, ROUTES.agents, {
    searchParams: next,
    replace: true,
  });
});

export const setupBillingSettingsRedirect$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  params.delete("tab");
  params.set("settings", "billing");
  set(detachedNavigateTo$, ROUTES.agents, {
    searchParams: params,
    replace: true,
  });
});
