import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { array, boolean, object, string, type infer as zInfer } from "zod";

import {
  resolveFirewallBaseUrlVars,
  type FirewallConfig,
} from "../firewall-types";

const addressPolicyCaseSchema = object({
  name: string(),
  address: string(),
  expectedPublic: boolean(),
});

const contractSchema = object({
  addressPolicyCases: array(addressPolicyCaseSchema).min(1),
}).superRefine((contract, ctx) => {
  const seenNames = new Set<string>();
  for (const [index, testCase] of contract.addressPolicyCases.entries()) {
    if (seenNames.has(testCase.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["addressPolicyCases", index, "name"],
        message: `duplicate case name "${testCase.name}"`,
      });
    }
    seenNames.add(testCase.name);
  }
});

type AddressPolicyCase = zInfer<typeof addressPolicyCaseSchema>;

function loadContract(): zInfer<typeof contractSchema> {
  const rawContract: unknown = JSON.parse(
    fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "public-destination-policy-contract.json",
      ),
      "utf-8",
    ),
  );
  return contractSchema.parse(rawContract);
}

const publicDestinationFirewall = {
  name: "public-destination-policy-contract",
  apis: [
    {
      base: "${{ vars.BASE_URL }}",
      hostPolicy: { kind: "publicDestination" },
      auth: { headers: { Authorization: "Bearer token" } },
      permissions: [],
    },
  ],
} as const satisfies FirewallConfig;

function addressUrl(address: string): string {
  const authority = address.includes(":") ? `[${address}]` : address;
  return `https://${authority}`;
}

function assertAddressPolicy(testCase: AddressPolicyCase): void {
  const baseUrl = addressUrl(testCase.address);
  const resolve = (): string => {
    const firewalls = resolveFirewallBaseUrlVars([publicDestinationFirewall], {
      BASE_URL: baseUrl,
    });
    return firewalls[0]!.apis[0]!.base;
  };

  if (testCase.expectedPublic) {
    expect(resolve()).toBe(baseUrl);
    return;
  }

  expect(resolve).toThrow("host policy does not allow non-public IP literal");
}

const contract = loadContract();

describe("public destination address policy contract", () => {
  for (const testCase of contract.addressPolicyCases) {
    it(testCase.name, () => {
      assertAddressPolicy(testCase);
    });
  }
});
