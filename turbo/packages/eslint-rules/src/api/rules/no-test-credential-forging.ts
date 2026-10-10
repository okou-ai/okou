import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";
import { apiTestingDoc, lintedFile } from "../test-boundary.ts";

/** Helpers that mint, encrypt or verify credentials outside a real flow. */
const credentialForgingHelpers = [
  "signSandboxJwtForTests",
  "signPatJwtForTests",
  "signSkillImportJwtForTests",
  "encryptSecretForTests",
  "generateSandboxToken",
  "verifyOkouToken",
] as const;

const forgingHelpers = new Set<string>(credentialForgingHelpers);

interface Options {
  /**
   * Exact paths (relative to the linted package) of files that already used
   * these helpers when the ratchet was introduced. The list may only shrink.
   */
  readonly legacyConsumers?: readonly string[];
}

function nameOf(node: TSESTree.Node): string | undefined {
  if (node.type === AST_NODE_TYPES.Identifier) {
    return node.name;
  }
  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === "string") {
    return node.value;
  }
  return undefined;
}

/**
 * Credentials in API tests come from real sign-in, chat send and Runner claim
 * flows. New test files must not mint, encrypt or verify them locally.
 */
export const noTestCredentialForging = createRule<[Options], "forged">({
  name: "no-test-credential-forging",
  defaultOptions: [{}],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow new API test use of credential signing, encryption and verification helpers",
      requiresTypeChecking: false,
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          legacyConsumers: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1, pattern: "^[^*?]+$" },
          },
        },
      },
    ],
    messages: {
      forged: `Do not use {{name}} in API tests. Obtain credentials through the real sign-in, chat send or Runner claim flow; the legacy consumer list may only shrink. See ${apiTestingDoc("credentials-from-real-flows")}.`,
    },
  },
  create(context, [options]) {
    if ((options.legacyConsumers ?? []).includes(lintedFile(context))) {
      return {};
    }
    function check(node: TSESTree.Node, name: string | undefined) {
      if (name !== undefined && forgingHelpers.has(name)) {
        context.report({ node, messageId: "forged", data: { name } });
      }
    }
    return {
      ImportSpecifier(node: TSESTree.ImportSpecifier) {
        check(node, nameOf(node.imported));
      },
      ExportSpecifier(node: TSESTree.ExportSpecifier) {
        check(node, nameOf(node.local));
      },
      MemberExpression(node: TSESTree.MemberExpression) {
        if (!node.computed) {
          check(node, nameOf(node.property));
        } else if (node.property.type === AST_NODE_TYPES.Literal) {
          check(node, nameOf(node.property));
        }
      },
      "ObjectPattern > Property"(node: TSESTree.Property) {
        check(node, nameOf(node.key));
      },
    };
  },
});
