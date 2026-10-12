import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";
import { apiTestingDoc, isTestModule, lintedFile } from "../test-boundary.ts";

const testApiPath = /^\/api\/test(\/|$)/;

function propertyName(
  property: TSESTree.ObjectLiteralElement,
): string | undefined {
  if (
    property.type !== AST_NODE_TYPES.Property ||
    property.computed ||
    property.key.type !== AST_NODE_TYPES.Identifier
  ) {
    return undefined;
  }
  return property.key.name;
}

/**
 * Test-only HTTP surfaces are prohibited: no `routes/test-*` modules, no
 * `/api/test` route or contract paths, and no route handlers registered from
 * test modules. Tests mount production route slices through `setupApp()`.
 */
export const noTestOnlyRoutes = createRule({
  name: "no-test-only-routes",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow test-only API route modules, paths and registrations",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      testRouteModule: `Test-only route modules are prohibited. Mount production route slices through setupApp(); see ${apiTestingDoc("no-test-only-endpoints")}.`,
      testApiPath: `"/api/test" paths are prohibited in routes and contracts. Use production endpoints; see ${apiTestingDoc("no-test-only-endpoints")}.`,
      testRegistration: `Tests must not register their own route handlers. Mount production route slices through setupApp(); see ${apiTestingDoc("no-test-only-endpoints")}.`,
    },
  },
  create(context) {
    const file = lintedFile(context);
    const testModule = isTestModule(file);
    // Production code may not mention the path at all. Tests may use it as
    // sample data (for example a logged route string), but not as a declared
    // contract or route path.
    function checkPath(node: TSESTree.Node, value: string) {
      if (!testApiPath.test(value)) {
        return;
      }
      const parent = node.parent;
      const declaresPath =
        parent?.type === AST_NODE_TYPES.Property &&
        parent.value === node &&
        propertyName(parent) === "path";
      if (!testModule || declaresPath) {
        context.report({ node, messageId: "testApiPath" });
      }
    }
    return {
      Program(node: TSESTree.Program) {
        if (!testModule && /(^|\/)routes\/(.*\/)?test-[^/]*(\/|$)/.test(file)) {
          context.report({ node, messageId: "testRouteModule" });
        }
      },
      Literal(node: TSESTree.Literal) {
        if (typeof node.value === "string") {
          checkPath(node, node.value);
        }
      },
      TemplateLiteral(node: TSESTree.TemplateLiteral) {
        const head = node.quasis[0];
        if (head !== undefined) {
          checkPath(node, head.value.cooked ?? head.value.raw);
        }
      },
      ObjectExpression(node: TSESTree.ObjectExpression) {
        if (!testModule) {
          return;
        }
        const names = new Set(node.properties.map(propertyName));
        if (names.has("route") && names.has("handler")) {
          context.report({ node, messageId: "testRegistration" });
        }
      },
    };
  },
});
