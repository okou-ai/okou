import { command, computed, state } from "ccstate";
import { orgMembersContract } from "@okouai/api-contracts/contracts/org-member-routes";
import type {
  OrgMember,
  OrgPendingInvitation,
  OrgMembershipRequest,
} from "@okouai/api-contracts/contracts/org-members";
import { apiClient$ } from "../api-client";
import { accept } from "../../lib/accept.ts";

export type { OrgMember, OrgPendingInvitation, OrgMembershipRequest };

const orgMembersVersion$ = state(0);

const orgMembersResponse$ = computed(async (get) => {
  get(orgMembersVersion$);
  const createClient = get(apiClient$);
  const client = createClient(orgMembersContract);
  const result = await accept(client.members(), [200]);
  return result.body;
});

export const orgMembers$ = computed(async (get) => {
  const response = await get(orgMembersResponse$);
  return response.members ?? [];
});

export const orgMemberProfiles$ = computed(async (get) => {
  get(orgMembersVersion$);
  const createClient = get(apiClient$);
  const client = createClient(orgMembersContract);
  const result = await accept(
    client.members({ query: { view: "members" } }),
    [200],
  );
  return result.body.members;
});

export const orgPendingInvitations$ = computed(async (get) => {
  const response = await get(orgMembersResponse$);
  return response.pendingInvitations ?? [];
});

export const orgMembershipRequests$ = computed(async (get) => {
  const response = await get(orgMembersResponse$);
  return response.membershipRequests ?? [];
});

export const refreshOrgMembers$ = command(({ get, set }) => {
  set(orgMembersVersion$, get(orgMembersVersion$) + 1);
});
