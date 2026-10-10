import { createRule } from "../utils.ts";
import {
  apiTestingDoc,
  lintedFile,
  moduleSpecifierVisitors,
  resolvedModule,
} from "../test-boundary.ts";

const privateAccessKinds = [
  "db-package",
  "db-driver",
  "db-handle",
  "service",
  "internal-signal",
] as const;

type PrivateAccessKind = (typeof privateAccessKinds)[number];

interface InfrastructureEntry {
  /** Exact path relative to the linted package (no globs). */
  readonly file: string;
  readonly kinds: readonly PrivateAccessKind[];
  readonly reason: string;
}

interface Options {
  readonly infrastructure?: readonly InfrastructureEntry[];
}

const dbDrivers = [
  /^drizzle-orm(\/|$)/,
  /^pg(-[a-z-]+)?(\/|$)/,
  /^postgres(\/|$)/,
  /^@electric-sql\/pglite(\/|$)/,
];

function classify(
  specifier: string,
  resolved: string | undefined,
): PrivateAccessKind | undefined {
  if (resolved === undefined) {
    if (/^@okouai\/db(\/|$)/.test(specifier)) {
      return "db-package";
    }
    return dbDrivers.some((pattern) => pattern.test(specifier))
      ? "db-driver"
      : undefined;
  }
  if (
    /(^|\/)src\/lib\/db$/.test(resolved) ||
    /(^|\/)src\/signals\/external\/db$/.test(resolved)
  ) {
    return "db-handle";
  }
  if (/(^|\/)src\/signals\/services(\/|$)/.test(resolved)) {
    return "service";
  }
  if (/(^|\/)src\/signals\/(computed|commands)(\/|$)/.test(resolved)) {
    return "internal-signal";
  }
  return undefined;
}

const MESSAGE = `API tests and test helpers must not import {{kind}} modules ("{{specifier}}"). Construct, drive and observe cases through production endpoints; see ${apiTestingDoc("no-private-state-access")}.`;

/**
 * Keeps API tests, fixtures and helpers away from DB packages, drivers, app DB
 * handles, API services and internal computed/command modules. Only exact,
 * reasoned infrastructure files may hold the specific access they own.
 */
export const noTestPrivateAccess = createRule<[Options], "privateAccess">({
  name: "no-test-private-access",
  defaultOptions: [{}],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow API test modules from importing database, service or internal signal modules",
      requiresTypeChecking: false,
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          infrastructure: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["file", "kinds", "reason"],
              properties: {
                file: { type: "string", minLength: 1, pattern: "^[^*?]+$" },
                kinds: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", enum: [...privateAccessKinds] },
                },
                reason: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    ],
    messages: { privateAccess: MESSAGE },
  },
  create(context, [options]) {
    const file = lintedFile(context);
    const allowed = new Set<PrivateAccessKind>(
      (options.infrastructure ?? [])
        .filter((entry) => entry.file === file)
        .flatMap((entry) => entry.kinds),
    );
    return moduleSpecifierVisitors((node, specifier) => {
      const kind = classify(specifier, resolvedModule(context, specifier));
      if (kind !== undefined && !allowed.has(kind)) {
        context.report({
          node,
          messageId: "privateAccess",
          data: { kind, specifier },
        });
      }
    });
  },
});
