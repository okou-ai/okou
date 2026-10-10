import {
  orgContract,
  orgLeaveContract,
  orgDeleteContract,
} from "@okouai/api-contracts/contracts/org-routes";
import type { OrgResponse } from "@okouai/api-contracts/contracts/orgs";
import { orgOpenrouterPresetContract } from "@okouai/api-contracts/contracts/org-openrouter-preset";
import { http, HttpResponse } from "msw";
import { mockApi } from "../msw-contract.ts";

// Mock org data — default to admin role for development
let mockOrg: OrgResponse = {
  id: "org_1",
  name: "User 12345678",
  role: "admin",
};

let mockLogoUrl: string | null = null;
let mockOpenrouterPreset: string | null = null;

export function setMockOrg(overrides: Partial<OrgResponse>): void {
  mockOrg = { ...mockOrg, ...overrides };
}

export function resetMockOrg(): void {
  mockOpenrouterPreset = null;
  mockOrg = {
    id: "org_1",
    name: "User 12345678",
    role: "admin",
  };
}

export function resetMockOrgLogo(): void {
  mockLogoUrl = null;
}

export const apiOrgHandlers = [
  mockApi(orgOpenrouterPresetContract.get, ({ respond }) => {
    return respond(200, { openrouterPreset: mockOpenrouterPreset });
  }),
  mockApi(orgOpenrouterPresetContract.update, ({ body, respond }) => {
    mockOpenrouterPreset = body.openrouterPreset;
    return respond(200, { openrouterPreset: mockOpenrouterPreset });
  }),
  mockApi(orgContract.get, ({ respond }) => {
    return respond(200, mockOrg);
  }),

  mockApi(orgContract.update, ({ body, respond }) => {
    mockOrg = { ...mockOrg, ...body };
    return respond(200, mockOrg);
  }),

  mockApi(orgLeaveContract.leave, ({ respond }) => {
    return respond(200, { message: "Left org" });
  }),

  mockApi(orgDeleteContract.delete, ({ respond }) => {
    return respond(200, { message: "Org deleted" });
  }),

  http.get("*/api/org/logo", () => {
    return HttpResponse.json({ logoUrl: mockLogoUrl, hasImage: !!mockLogoUrl });
  }),
];
