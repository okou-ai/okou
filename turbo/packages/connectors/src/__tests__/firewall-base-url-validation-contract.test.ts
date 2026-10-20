import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FIREWALL_HOSTNAME_POLICY_VERSION } from "../firewall-hostname-policy";
import {
  canonicalizeFirewallBaseUrl,
  canonicalizeFirewallBaseUrlVarsForExecution,
  firewallsSchema,
  resolveFirewallBaseUrlTemplate,
  validateBaseUrl,
} from "../firewall-types";

const baseUrlTemplateResolutionCaseSchema = z.object({
  name: z.string(),
  category: z.string().optional(),
  base: z.string(),
  vars: z.record(z.string(), z.string()),
  expectedResolvedBase: z.string().nullable(),
  // Python preserves encoded host text; TypeScript returns its canonical form.
  expectedCanonicalBase: z.string().optional(),
});

const baseUrlValidationCaseSchema = z.object({
  name: z.string(),
  category: z.string().optional(),
  note: z.string().optional(),
  base: z.string(),
  expectedValid: z.boolean(),
  expectedCanonicalBase: z.string().optional(),
});

const catalogBaseUrlValidationCaseSchema = baseUrlTemplateResolutionCaseSchema
  .extend({
    expectedValid: z.boolean(),
  })
  .superRefine((testCase, ctx) => {
    if (testCase.expectedValid === (testCase.expectedResolvedBase === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedResolvedBase"],
        message:
          "expectedResolvedBase must be present exactly when expectedValid is true",
      });
    }
  });

const contractSchema = z
  .object({
    hostnamePolicy: z.literal(FIREWALL_HOSTNAME_POLICY_VERSION),
    baseUrlTemplateResolutionCases: z
      .array(baseUrlTemplateResolutionCaseSchema)
      .min(1),
    catalogBaseUrlValidationCases: z
      .array(catalogBaseUrlValidationCaseSchema)
      .min(1),
    baseUrlValidationCases: z.array(baseUrlValidationCaseSchema).min(1),
  })
  .superRefine((contract, ctx) => {
    for (const [collectionName, testCases] of [
      [
        "baseUrlTemplateResolutionCases",
        contract.baseUrlTemplateResolutionCases,
      ],
      ["catalogBaseUrlValidationCases", contract.catalogBaseUrlValidationCases],
      ["baseUrlValidationCases", contract.baseUrlValidationCases],
    ] as const) {
      const seenNames = new Set<string>();
      for (const [index, testCase] of testCases.entries()) {
        if (seenNames.has(testCase.name)) {
          ctx.addIssue({
            code: "custom",
            path: [collectionName, index, "name"],
            message: `duplicate case name "${testCase.name}"`,
          });
        }
        seenNames.add(testCase.name);
      }
    }
  });

type BaseUrlValidationCase = z.infer<typeof baseUrlValidationCaseSchema>;
type CatalogBaseUrlValidationCase = z.infer<
  typeof catalogBaseUrlValidationCaseSchema
>;
type BaseUrlTemplateResolutionCase = z.infer<
  typeof baseUrlTemplateResolutionCaseSchema
>;

function loadContract(): z.infer<typeof contractSchema> {
  const rawContract: unknown = JSON.parse(
    fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "firewall-base-url-validation-contract.json",
      ),
      "utf-8",
    ),
  );
  return contractSchema.parse(rawContract);
}

function assertValidationResult(testCase: BaseUrlValidationCase): void {
  const validate = (): void => {
    validateBaseUrl(testCase.base, "contract");
  };

  if (testCase.expectedValid) {
    expect(validate).not.toThrow();
    if (testCase.expectedCanonicalBase !== undefined) {
      expect(canonicalizeFirewallBaseUrl(testCase.base, "contract")).toBe(
        testCase.expectedCanonicalBase,
      );
    }
    return;
  }

  expect(validate).toThrow();
}

function assertTemplateResolutionResult(
  testCase: BaseUrlTemplateResolutionCase,
): void {
  const resolve = (): string => {
    return resolveFirewallBaseUrlTemplate({
      serviceName: "contract",
      base: testCase.base,
      vars: testCase.vars,
    });
  };

  if (testCase.expectedResolvedBase === null) {
    expect(resolve).toThrow();
    return;
  }

  expect(resolve()).toBe(
    testCase.expectedCanonicalBase ?? testCase.expectedResolvedBase,
  );
}

function assertCatalogValidationResult(
  testCase: CatalogBaseUrlValidationCase,
): void {
  const validate = (): string => {
    firewallsSchema.parse([
      {
        name: "contract",
        apis: [{ base: testCase.base, auth: {} }],
      },
    ]);
    validateBaseUrl(testCase.base, "contract");
    return resolveFirewallBaseUrlTemplate({
      serviceName: "contract",
      base: testCase.base,
      vars: testCase.vars,
    });
  };

  if (!testCase.expectedValid) {
    expect(validate).toThrow();
    return;
  }

  expect(testCase.expectedResolvedBase).not.toBeNull();
  expect(validate()).toBe(
    testCase.expectedCanonicalBase ?? testCase.expectedResolvedBase,
  );
}

const contract = loadContract();

describe("firewall base URL validation contract", () => {
  for (const testCase of contract.baseUrlValidationCases) {
    it(testCase.name, () => {
      assertValidationResult(testCase);
    });
  }
});

describe("firewall catalog base URL validation contract", () => {
  for (const testCase of contract.catalogBaseUrlValidationCases) {
    it(testCase.name, () => {
      assertCatalogValidationResult(testCase);
    });
  }
});

describe("firewall base URL template resolution contract", () => {
  for (const testCase of contract.baseUrlTemplateResolutionCases) {
    it(testCase.name, () => {
      assertTemplateResolutionResult(testCase);
    });
  }
});

describe("credentialed split hostname escapes", () => {
  it.each([
    ["https://%6${{ vars.SUFFIX }}.example.com", "1"],
    ["https://%${{ vars.SUFFIX }}.example.com", "61"],
  ])(
    "preserves execution variables and enforces ownership for %s",
    (base, suffix) => {
      const hostPolicy = {
        kind: "providerOwned" as const,
        exactHosts: ["a.example.com"],
      };
      const firewalls = firewallsSchema.parse([
        {
          name: "contract",
          apis: [
            {
              base,
              hostPolicy,
              auth: {
                headers: { Authorization: "Bearer ${{ secrets.TOKEN }}" },
              },
            },
          ],
        },
      ]);
      const vars = canonicalizeFirewallBaseUrlVarsForExecution(firewalls, {
        SUFFIX: suffix,
      });
      expect(vars).toEqual({ SUFFIX: suffix });
      expect(
        resolveFirewallBaseUrlTemplate({
          serviceName: "contract",
          base,
          vars,
          credentialed: true,
          hostPolicy,
        }),
      ).toBe("https://a.example.com");
      expect(() => {
        return resolveFirewallBaseUrlTemplate({
          serviceName: "contract",
          base,
          vars: { SUFFIX: suffix === "1" ? "2" : "62" },
          credentialed: true,
          hostPolicy,
        });
      }).toThrow("host policy does not allow resolved host");
    },
  );
});
