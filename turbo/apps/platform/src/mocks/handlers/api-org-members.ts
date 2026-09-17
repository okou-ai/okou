import {
  orgMembersContract,
  orgInviteContract,
  orgMembershipRequestsContract,
} from "@okouai/api-contracts/contracts/org-member-routes";
import type { OrgMembersResponse } from "@okouai/api-contracts/contracts/org-members";
import { mockApi } from "../msw-contract.ts";

let mockOrgMembersResponse: OrgMembersResponse = {
  name: "User Workspace",
  role: "admin",
  members: [],
  pendingInvitations: [],
  membershipRequests: [],
  createdAt: "2024-01-01T00:00:00Z",
};

export function setMockOrgMembers(
  overrides: Partial<OrgMembersResponse>,
): void {
  mockOrgMembersResponse = { ...mockOrgMembersResponse, ...overrides };
}

export function resetMockOrgMembers(): void {
  mockOrgMembersResponse = {
    name: "User Workspace",
    role: "admin",
    members: [],
    pendingInvitations: [],
    membershipRequests: [],
    createdAt: "2024-01-01T00:00:00Z",
  };
}

export const apiOrgMembersHandlers = [
  mockApi(orgMembersContract.members, ({ query, respond }) => {
    if (query.view === "members") {
      return respond(200, {
        name: mockOrgMembersResponse.name,
        role: mockOrgMembersResponse.role,
        members: mockOrgMembersResponse.members,
        createdAt: mockOrgMembersResponse.createdAt,
      });
    }
    return respond(200, mockOrgMembersResponse);
  }),

  mockApi(orgMembersContract.updateRole, ({ respond }) => {
    return respond(200, { message: "Role updated" });
  }),

  mockApi(orgMembersContract.removeMember, ({ respond }) => {
    return respond(200, { message: "Member removed" });
  }),

  mockApi(orgInviteContract.invite, ({ respond }) => {
    return respond(200, { message: "Invitation sent" });
  }),

  mockApi(orgInviteContract.revoke, ({ respond }) => {
    return respond(200, { message: "Invitation revoked" });
  }),

  mockApi(orgMembershipRequestsContract.accept, ({ respond }) => {
    return respond(200, { message: "Request accepted" });
  }),

  mockApi(orgMembershipRequestsContract.reject, ({ respond }) => {
    return respond(200, { message: "Request rejected" });
  }),
];
