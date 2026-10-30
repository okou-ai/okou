import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  array,
  boolean,
  discriminatedUnion,
  literal,
  object,
  record,
  string,
  union,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { validateRule } from "../firewall-expander";
import {
  type FirewallRequestDecision,
  matchFirewallBaseUrl,
  matchFirewallHost,
  matchFirewallPath,
  matchFirewallPathPrefix,
  matchFirewallRequestDecision,
} from "../firewall-rule-matcher";
import { parseSegment, splitPathSegments } from "../segment-parser";

const segmentExpectedSchema = discriminatedUnion("kind", [
  object({
    kind: literal("literal"),
    value: string(),
  }),
  object({
    kind: literal("param"),
    prefix: string(),
    name: string(),
    suffix: string(),
    greedy: union([literal(""), literal("+"), literal("*")]),
    constraint: literal("digits").optional(),
  }),
  object({
    kind: literal("error"),
    reasonIncludes: string(),
  }),
]);

const paramsMatchExpectedSchema = discriminatedUnion("kind", [
  object({
    kind: literal("match"),
    params: record(string(), string()),
  }),
  object({
    kind: literal("no-match"),
  }),
]);

const relativePathMatchExpectedSchema = discriminatedUnion("kind", [
  object({
    kind: literal("match"),
    relativePath: string(),
  }),
  object({
    kind: literal("no-match"),
  }),
]);

const firewallDecisionExpectedSchema = discriminatedUnion("kind", [
  object({
    kind: literal("no_match"),
  }),
  object({
    kind: literal("allow"),
    firewallName: string(),
    base: string(),
    relativePath: string(),
    permission: string().optional(),
    rule: string().optional(),
  }),
  object({
    kind: literal("block"),
    firewallName: string(),
    base: string(),
    relativePath: string(),
    reason: union([
      literal("permission_denied"),
      literal("unknown_endpoint"),
      literal("malformed_firewall_config"),
      literal("malformed_network_policy"),
      literal("unsafe_path"),
    ]),
    permissions: array(string()),
  }),
  object({
    kind: literal("ambiguous"),
    method: string(),
    path: string(),
    candidates: array(string()),
    reason: union([
      literal("connector_intent_required"),
      literal("malformed_connector_intent"),
      literal("connector_intent_not_candidate"),
    ]),
  }),
]);

const connectorIntentSchema = discriminatedUnion("status", [
  object({ status: literal("absent") }),
  object({ status: literal("malformed") }),
  object({ status: literal("present"), value: string() }),
]);

const contractSchema = object({
  awsRuleValidationCases: array(
    object({
      name: string(),
      rule: string(),
      valid: boolean(),
    }),
  ),
  segmentParseCases: array(
    object({
      name: string(),
      segment: string(),
      expected: segmentExpectedSchema,
    }),
  ),
  pathSplitCases: array(
    object({
      name: string(),
      path: string(),
      expected: array(string()),
    }),
  ),
  pathMatchCases: array(
    object({
      name: string(),
      path: string(),
      pattern: string(),
      expected: paramsMatchExpectedSchema,
    }),
  ),
  hostMatchCases: array(
    object({
      name: string(),
      host: string(),
      pattern: string(),
      expected: paramsMatchExpectedSchema,
    }),
  ),
  pathPrefixMatchCases: array(
    object({
      name: string(),
      path: string(),
      pattern: string(),
      expected: relativePathMatchExpectedSchema,
    }),
  ),
  baseUrlMatchCases: array(
    object({
      name: string(),
      url: string(),
      base: string(),
      expected: relativePathMatchExpectedSchema,
    }),
  ),
  finalDecisionCases: array(
    object({
      name: string(),
      firewalls: zUnknown(),
      networkPolicies: zUnknown().optional(),
      request: object({
        method: string(),
        url: string(),
        connectorIntent: connectorIntentSchema.optional(),
      }),
      expected: firewallDecisionExpectedSchema,
    }),
  ),
});

type SegmentExpected = zInfer<typeof segmentExpectedSchema>;
type ParamsMatchExpected = zInfer<typeof paramsMatchExpectedSchema>;
type RelativePathMatchExpected = zInfer<typeof relativePathMatchExpectedSchema>;
type FirewallDecisionExpected = zInfer<typeof firewallDecisionExpectedSchema>;

function loadContract(): zInfer<typeof contractSchema> {
  const rawContract: unknown = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, "firewall-semantics-contract.json"),
      "utf-8",
    ),
  );
  return contractSchema.parse(rawContract);
}

function assertSegmentResult(segment: string, expected: SegmentExpected): void {
  const actual = parseSegment(segment);
  if (expected.kind === "error") {
    if (actual.kind !== "error") {
      throw new Error(
        `Expected segment "${segment}" to fail parsing, got ${JSON.stringify(actual)}`,
      );
    }
    expect(actual.reason).toContain(expected.reasonIncludes);
    return;
  }

  expect(actual).toEqual(expected);
}

function assertParamsMatch(
  actual: Record<string, string> | null,
  expected: ParamsMatchExpected,
): void {
  if (expected.kind === "no-match") {
    expect(actual).toBeNull();
    return;
  }

  expect(actual).toEqual(expected.params);
}

function assertRelativePathMatch(
  actual: string | null,
  expected: RelativePathMatchExpected,
): void {
  if (expected.kind === "no-match") {
    expect(actual).toBeNull();
    return;
  }

  expect(actual).toBe(expected.relativePath);
}

function assertFirewallDecision(
  actual: FirewallRequestDecision,
  expected: FirewallDecisionExpected,
): void {
  expect(actual).toEqual(expected);
}

const contract = loadContract();

describe("firewall semantics contract", () => {
  describe("AWS rule validation", () => {
    for (const testCase of contract.awsRuleValidationCases) {
      it(testCase.name, () => {
        const validate = (): void => {
          validateRule(testCase.rule, "permission", "aws", {
            allowAwsPredicates: true,
          });
        };
        if (testCase.valid) {
          expect(validate).not.toThrow();
        } else {
          expect(validate).toThrow();
        }
      });
    }
  });

  describe("segment parsing", () => {
    for (const testCase of contract.segmentParseCases) {
      it(testCase.name, () => {
        assertSegmentResult(testCase.segment, testCase.expected);
      });
    }
  });

  describe("path splitting", () => {
    for (const testCase of contract.pathSplitCases) {
      it(testCase.name, () => {
        expect(splitPathSegments(testCase.path)).toEqual(testCase.expected);
      });
    }
  });

  describe("path matching", () => {
    for (const testCase of contract.pathMatchCases) {
      it(testCase.name, () => {
        assertParamsMatch(
          matchFirewallPath(testCase.path, testCase.pattern),
          testCase.expected,
        );
      });
    }
  });

  describe("host matching", () => {
    for (const testCase of contract.hostMatchCases) {
      it(testCase.name, () => {
        assertParamsMatch(
          matchFirewallHost(testCase.host, testCase.pattern),
          testCase.expected,
        );
      });
    }
  });

  describe("path prefix matching", () => {
    for (const testCase of contract.pathPrefixMatchCases) {
      it(testCase.name, () => {
        assertRelativePathMatch(
          matchFirewallPathPrefix(testCase.path, testCase.pattern),
          testCase.expected,
        );
      });
    }
  });

  describe("base URL matching", () => {
    for (const testCase of contract.baseUrlMatchCases) {
      it(testCase.name, () => {
        assertRelativePathMatch(
          matchFirewallBaseUrl(testCase.url, testCase.base)?.relativePath ??
            null,
          testCase.expected,
        );
      });
    }
  });

  describe("final request decisions", () => {
    for (const testCase of contract.finalDecisionCases) {
      it(testCase.name, () => {
        assertFirewallDecision(
          matchFirewallRequestDecision(
            testCase.firewalls,
            testCase.request.method,
            testCase.request.url,
            testCase.networkPolicies,
            testCase.request.connectorIntent,
          ),
          testCase.expected,
        );
      });
    }
  });
});
