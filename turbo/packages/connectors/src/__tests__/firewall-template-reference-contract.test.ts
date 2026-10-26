import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  array,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { extractFirewallTemplateReferences } from "../firewall-types";

const templateReferenceSchema = object({
  namespace: zEnum(["secrets", "vars"]),
  name: string(),
  source: string().min(1),
});
const templateReferencesSchema = object({
  secrets: array(string()),
  vars: array(string()),
});
const simpleReferenceCaseSchema = object({
  name: string(),
  template: string(),
  expectedReferences: array(templateReferenceSchema),
});
const basicTemplateCaseSchema = object({
  name: string(),
  template: string(),
  expectedTemplateReferences: templateReferencesSchema,
  expectedDiagnosticNames: array(string()),
});
const contractSchema = object({
  simpleReferenceCases: array(simpleReferenceCaseSchema).min(1),
  basicTemplateCases: array(basicTemplateCaseSchema).min(1),
}).superRefine((contract, ctx) => {
  const seenNames = new Set<string>();
  const cases = [
    ...contract.simpleReferenceCases,
    ...contract.basicTemplateCases,
  ];
  for (const [index, testCase] of cases.entries()) {
    if (seenNames.has(testCase.name)) {
      ctx.addIssue({
        code: "custom",
        path: [index, "name"],
        message: `duplicate case name "${testCase.name}"`,
      });
    }
    seenNames.add(testCase.name);
  }
});

type SimpleReferenceCase = zInfer<typeof simpleReferenceCaseSchema>;

function loadContract(): zInfer<typeof contractSchema> {
  const rawContract: unknown = JSON.parse(
    fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "firewall-template-reference-contract.json",
      ),
      "utf-8",
    ),
  );
  return contractSchema.parse(rawContract);
}

function extractReferences(template: string): {
  readonly secrets: readonly string[];
  readonly vars: readonly string[];
} {
  return extractFirewallTemplateReferences([
    {
      base: "https://contract.example.com",
      auth: { headers: { Authorization: template } },
    },
  ]);
}

function expectedSimpleReferences(testCase: SimpleReferenceCase): {
  readonly secrets: readonly string[];
  readonly vars: readonly string[];
} {
  const secrets = new Set<string>();
  const vars = new Set<string>();
  for (const reference of testCase.expectedReferences) {
    const names = reference.namespace === "secrets" ? secrets : vars;
    names.add(reference.name);
  }
  return { secrets: [...secrets], vars: [...vars] };
}

const contract = loadContract();

describe("firewall template reference contract", () => {
  for (const testCase of contract.simpleReferenceCases) {
    it(testCase.name, () => {
      expect(extractReferences(testCase.template)).toStrictEqual(
        expectedSimpleReferences(testCase),
      );
    });
  }

  for (const testCase of contract.basicTemplateCases) {
    it(testCase.name, () => {
      expect(extractReferences(testCase.template)).toStrictEqual(
        testCase.expectedTemplateReferences,
      );
    });
  }
});
