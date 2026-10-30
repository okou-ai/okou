import { computed } from "ccstate";
import { orgLogoContract } from "@okouai/api-contracts/client/org-logo";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { org$ } from "../../org.ts";
import { settingsDialogOpen$ } from "./settings-dialog.ts";

export const profileLogoUrl$ = computed(async (get) => {
  if (!get(settingsDialogOpen$)) {
    return null;
  }
  const org = await get(org$);
  if (!org) {
    return null;
  }
  const result = await accept(get(apiClient$)(orgLogoContract).get(), [200]);
  // Clerk returns a generated placeholder URL for a workspace that never
  // uploaded a logo; the page draws its own default for that case instead.
  return result.body.hasImage ? result.body.logoUrl : null;
});
