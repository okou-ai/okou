import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

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

const segmentExpectedSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("literal"),
    value: z.string(),
  }),
  z.object({
    kind: z.literal("param"),
    prefix: z.string(),
    name: z.string(),
    suffix: z.string(),
    greedy: z.union([z.literal(""), z.literal("+"), z.literal("*")]),
  }),
  z.object({
    kind: z.literal("error"),
    reasonIncludes: z.string(),
  }),
]);

const paramsMatchExpectedSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("match"),
    params: z.record(z.string(), z.string()),
  }),
  z.object({
    kind: z.literal("no-match"),
  }),
]);

const relativePathMatchExpectedSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("match"),
    relativePath: z.string(),
  }),
  z.object({
    kind: z.literal("no-match"),
  }),
]);

const firewallDecisionExpectedSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("no_match"),
  }),
  z.object({
    kind: z.literal("allow"),
    firewallName: z.string(),
    base: z.string(),
    relativePath: z.string(),
    permission: z.string().optional(),
    rule: z.string().optional(),
  }),
  z.object({
    kind: z.literal("block"),
    firewallName: z.string(),
    base: z.string(),
    relativePath: z.string(),
    reason: z.union([
      z.literal("permission_denied"),
      z.literal("unknown_endpoint"),
      z.literal("malformed_firewall_config"),
      z.literal("malformed_network_policy"),
      z.literal("unsafe_path"),
    ]),
    permissions: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("ambiguous"),
    method: z.string(),
    path: z.string(),
    candidates: z.array(z.string()),
    reason: z.union([
      z.literal("connector_intent_required"),
      z.literal("malformed_connector_intent"),
      z.literal("connector_intent_not_candidate"),
    ]),
  }),
]);

const connectorIntentSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }),
  z.object({ status: z.literal("malformed") }),
  z.object({ status: z.literal("present"), value: z.string() }),
]);

const contractSchema = z.object({
  awsRuleValidationCases: z.array(
    z.object({
      name: z.string(),
      rule: z.string(),
      valid: z.boolean(),
    }),
  ),
  segmentParseCases: z.array(
    z.object({
      name: z.string(),
      segment: z.string(),
      expected: segmentExpectedSchema,
    }),
  ),
  pathSplitCases: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      expected: z.array(z.string()),
    }),
  ),
  pathMatchCases: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      pattern: z.string(),
      expected: paramsMatchExpectedSchema,
    }),
  ),
  hostMatchCases: z.array(
    z.object({
      name: z.string(),
      host: z.string(),
      pattern: z.string(),
      expected: paramsMatchExpectedSchema,
    }),
  ),
  pathPrefixMatchCases: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      pattern: z.string(),
      expected: relativePathMatchExpectedSchema,
    }),
  ),
  baseUrlMatchCases: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      base: z.string(),
      expected: relativePathMatchExpectedSchema,
    }),
  ),
  finalDecisionCases: z.array(
    z.object({
      name: z.string(),
      firewalls: z.unknown(),
      networkPolicies: z.unknown().optional(),
      request: z.object({
        method: z.string(),
        url: z.string(),
        connectorIntent: connectorIntentSchema.optional(),
      }),
      expected: firewallDecisionExpectedSchema,
    }),
  ),
});

type SegmentExpected = z.infer<typeof segmentExpectedSchema>;
type ParamsMatchExpected = z.infer<typeof paramsMatchExpectedSchema>;
type RelativePathMatchExpected = z.infer<
  typeof relativePathMatchExpectedSchema
>;
type FirewallDecisionExpected = z.infer<typeof firewallDecisionExpectedSchema>;

function loadContract(): z.infer<typeof contractSchema> {
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
