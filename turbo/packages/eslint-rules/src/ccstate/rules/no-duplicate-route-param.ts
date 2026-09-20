/**
 * ESLint rule: no-duplicate-route-param
 *
 * Enforces that the same route parameter name is not reused under different
 * path segments. This prevents cross-route signal leakage where a signal
 * reads `pathParams$.paramName` and accidentally resolves on the wrong page.
 *
 * Good: `/agents/:agentId` and `/agents/:agentId/chat` (same segment)
 * Bad:  `/agents/:id` and `/activities/:id` (different segments, same param)
 */

import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/okou-ai/okou/blob/main/docs/eslint/${name}.md`,
);

type MessageIds = "duplicateRouteParam";

interface ParamOccurrence {
  node: TSESTree.Literal;
  segment: string;
  path: string;
}

/**
 * Extract (segment, paramName) pairs from a route path string.
 * For "/agents/:agentId/chat", returns [["agents", "agentId"]].
 * For "/connectors/:connectorSlug/connect", returns [["connectors", "connectorSlug"]].
 */
function extractSegmentParamPairs(
  path: string,
): { segment: string; param: string }[] {
  const parts = path.split("/").filter(Boolean);
  const pairs: { segment: string; param: string }[] = [];

  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":") && i > 0) {
      pairs.push({
        segment: parts[i - 1],
        param: parts[i].slice(1),
      });
    }
  }

  return pairs;
}

export default createRule<[], MessageIds>({
  name: "no-duplicate-route-param",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the same route parameter name under different path segments",
    },
    schema: [],
    messages: {
      duplicateRouteParam:
        "Route param ':{{param}}' is used under segment '{{segment}}' but already appears under '{{existingSegment}}'. Use a unique param name to prevent cross-route signal leakage.",
    },
  },
  defaultOptions: [],
  create(context) {
    const paramMap = new Map<string, ParamOccurrence[]>();

    return {
      Literal(node) {
        if (typeof node.value !== "string") {
          return;
        }

        const value = node.value;
        if (!value.includes("/:")) {
          return;
        }

        const pairs = extractSegmentParamPairs(value);
        for (const { segment, param } of pairs) {
          const occurrences = paramMap.get(param) ?? [];
          occurrences.push({ node, segment, path: value });
          paramMap.set(param, occurrences);
        }
      },

      "Program:exit"() {
        for (const [param, occurrences] of paramMap) {
          const segments = new Set(occurrences.map((o) => o.segment));
          if (segments.size <= 1) {
            continue;
          }

          const segmentList = [...segments];
          for (const occurrence of occurrences) {
            const otherSegments = segmentList.filter(
              (s) => s !== occurrence.segment,
            );
            if (otherSegments.length > 0) {
              context.report({
                node: occurrence.node,
                messageId: "duplicateRouteParam",
                data: {
                  param,
                  segment: occurrence.segment,
                  existingSegment: otherSegments.join(", "),
                },
              });
            }
          }
        }
      },
    };
  },
});
