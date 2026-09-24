import { command, computed, state } from "ccstate";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import { apiClient$ } from "./api-client.ts";
import { accept } from "../lib/accept.ts";

const reloadOrg$ = state(0);
const reloadCreatedOrganizationsCount$ = state(0);

/**
 * Current user's default org.
 * Returns undefined when the API reports that the user has no org.
 */
export const org$ = computed(async (get) => {
  get(reloadOrg$);
  const createClient = get(apiClient$);
  const client = createClient(orgContract);
  // 404 is a valid response: a newly-signed-up user has no org yet.
  const result = await accept(client.get(), [200, 404]);

  if (result.status === 404) {
    return undefined;
  }

  return result.body;
});

export const createdOrganizationsCount$ = computed(async (get) => {
  get(reloadCreatedOrganizationsCount$);
  const createClient = get(apiClient$);
  const client = createClient(orgContract);
  const result = await accept(client.createdCount(), [200]);
  return result.body.createdOrganizationsCount;
});

/**
 * Current user's role in their org.
 * Defaults to "member" if org is not available.
 */
const orgRole$ = computed(async (get) => {
  const org = await get(org$);
  return org?.role ?? "member";
});

/**
 * Whether the current user is an admin of their org.
 */
export const isOrgAdmin$ = computed(async (get) => {
  const role = await get(orgRole$);
  return role === "admin";
});

/**
 * Trigger a re-fetch of the org signal.
 */
export const refreshOrg$ = command(({ set }) => {
  set(reloadOrg$, (x) => {
    return x + 1;
  });
});

export const refreshCreatedOrganizationsCount$ = command(({ set }) => {
  set(reloadCreatedOrganizationsCount$, (x) => {
    return x + 1;
  });
});
