import type { Rule } from "eslint";

type NodeWithCallee = Rule.Node & {
  arguments?: readonly Rule.Node[];
  callee?: Rule.Node;
};

type NodeWithInit = Rule.Node & {
  id?: Rule.Node;
  init?: Rule.Node | null;
};

type MemberExpressionNode = Rule.Node & {
  computed?: boolean;
  object?: Rule.Node;
  property?: Rule.Node;
};

type LiteralNode = Rule.Node & {
  value?: unknown;
};

interface NoLoggerInfoOptions {
  readonly allowedMessages?: readonly string[];
}

function isNamedIdentifier(node: Rule.Node | undefined, name: string): boolean {
  return node?.type === "Identifier" && node.name === name;
}

function isLoggerCall(node: Rule.Node | undefined): boolean {
  if (node?.type !== "CallExpression") {
    return false;
  }

  return isNamedIdentifier((node as NodeWithCallee).callee, "logger");
}

function getInfoObject(node: Rule.Node): Rule.Node | null {
  const callExpression = node as NodeWithCallee;
  if (callExpression.callee?.type !== "MemberExpression") {
    return null;
  }

  const member = callExpression.callee as MemberExpressionNode;
  if (
    member.computed === false &&
    isNamedIdentifier(member.property, "info") &&
    member.object
  ) {
    return member.object;
  }

  return null;
}

function getStaticMessage(node: Rule.Node): string | null {
  const firstArgument = (node as NodeWithCallee).arguments?.[0] as
    LiteralNode | undefined;
  if (
    firstArgument?.type === "Literal" &&
    typeof firstArgument.value === "string"
  ) {
    return firstArgument.value;
  }
  return null;
}

export const noLoggerInfo: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow info-level API logs except explicitly allowed static audit messages",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedMessages: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noLoggerInfo:
        "Do not use logger.info() in API source. Use debug for routine diagnostics or warn/error/fatal for actionable issues.",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as NoLoggerInfoOptions;
    const allowedMessages = new Set(options.allowedMessages ?? []);
    const filename = context.filename ?? context.getFilename();
    if (filename.includes("/__tests__/")) {
      return {};
    }

    const loggerVariables = new Set<string>();

    return {
      VariableDeclarator(node: Rule.Node) {
        const declarator = node as NodeWithInit;
        if (
          declarator.id?.type === "Identifier" &&
          isLoggerCall(declarator.init ?? undefined)
        ) {
          loggerVariables.add(declarator.id.name);
        }
      },
      CallExpression(node: Rule.Node) {
        const object = getInfoObject(node);
        if (!object) {
          return;
        }

        if (
          isLoggerCall(object) ||
          (object.type === "Identifier" && loggerVariables.has(object.name))
        ) {
          const message = getStaticMessage(node);
          if (message !== null && allowedMessages.has(message)) {
            return;
          }
          context.report({
            node,
            messageId: "noLoggerInfo",
          });
        }
      },
    };
  },
};
