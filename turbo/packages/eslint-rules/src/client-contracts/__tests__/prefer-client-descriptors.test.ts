import { RuleTester } from "@typescript-eslint/rule-tester";
import { TSESLint } from "@typescript-eslint/utils";
import ts from "typescript";
import { parser } from "typescript-eslint";
import { afterAll, describe, expect, it } from "vitest";

import { preferClientDescriptors } from "../prefer-client-descriptors.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const filename = "/repo/turbo/apps/platform/src/example.ts";
const contractsDirectory = "/repo/turbo/packages/api-contracts/src/contracts";
const ruleOptions = {
  contractsDirectory,
  modules: [
    {
      module: "agents",
      contracts: ["agentsMainContract", "agentsByIdContract"],
      bindings: [
        {
          name: "agentVisibilitySchema",
          source: "validators/agents",
          imported: "agentVisibilitySchema",
        },
        {
          name: "AGENT_VISIBILITIES",
          source: "validators/agents",
          imported: "AGENT_VISIBILITIES",
        },
        {
          name: "chatThreadDraftSchema",
          source: "validators/draft-composer",
          imported: "composerDraftSchema",
        },
      ],
    },
    {
      module: "billing",
      contracts: ["billingMainContract"],
      bindings: [
        {
          name: "billingCurrencySchema",
          source: "validators/billing",
          imported: "billingCurrencySchema",
        },
        {
          name: "agentVisibilitySchema",
          source: "validators/agents",
          imported: "agentVisibilitySchema",
        },
      ],
    },
  ],
};
const options: [typeof ruleOptions] = [ruleOptions];
const agentsSource = "@okouai/api-contracts/contracts/agents";
const billingSource = "@okouai/api-contracts/contracts/billing";
const runtimeBarrels = [
  "@okouai/api-contracts",
  "@okouai/api-contracts/contracts",
  "@okouai/api-contracts/contracts/index",
  "@okouai/core",
  "@okouai/core/contracts",
  "@okouai/api-contracts/index",
  "@okouai/core/index",
  "@okouai/core/contracts/index.js",
  "../../../packages/api-contracts/src/index.ts",
  "../../../packages/core/src/index.ts",
  "/repo/turbo/packages/core/src/contracts/index.js",
  "../../../packages/core/src",
];
const transportImport =
  'import { initClient } from "@okouai/api-contracts/client/transport";';
const signalImports = `import { computed } from "ccstate";
import { apiClient$ } from "./signals/api-client.ts";`;

const tester = new RuleTester({
  defaultFilenames: {
    ts: filename,
    tsx: "/repo/turbo/apps/platform/src/example.tsx",
  },
  languageOptions: { parser, ecmaVersion: "latest", sourceType: "module" },
});

function safeRouterCase(name: string, code: string) {
  return {
    name,
    code,
    options,
    errors: [{ messageId: "preferClient" as const }],
    output: code.replace(agentsSource, "@okouai/api-contracts/client/agents"),
  };
}

function manualCase(name: string, code: string) {
  return {
    name,
    code,
    options,
    errors: [{ messageId: "manualMigration" as const }],
    output: null,
  };
}

function runtimeCase(name: string, code: string) {
  return {
    name,
    code,
    options,
    errors: [{ messageId: "runtimeImport" as const }],
    output: null,
  };
}

tester.run("prefer-client-descriptors", preferClientDescriptors, {
  valid: [
    {
      name: "generated descriptors are already schema-free",
      code: 'import { agentsMainContract } from "@okouai/api-contracts/client/agents"; consume(agentsMainContract);',
      options,
    },
    {
      name: "independent validators retain runtime validation",
      code: 'import { agentVisibilitySchema } from "@okouai/api-contracts/validators/agents"; agentVisibilitySchema.parse(input);',
      options,
    },
    {
      name: "pure schema contract modules need no migration",
      code: 'import { orgRoleSchema } from "@okouai/api-contracts/contracts/orgs"; orgRoleSchema.parse(input);',
      options,
    },
    {
      name: "pure schema namespace imports are allowed",
      code: 'import * as orgs from "@okouai/api-contracts/contracts/orgs"; orgs.orgRoleSchema.parse(input);',
      options,
    },
    {
      name: "pure schema reexports are allowed",
      code: 'export { orgRoleSchema } from "@okouai/api-contracts/contracts/orgs";',
      options,
    },
    {
      name: "relative pure schema imports are allowed",
      code: 'import { orgRoleSchema } from "../../../packages/api-contracts/src/contracts/orgs.ts"; orgRoleSchema.parse(input);',
      options,
    },
    {
      name: "original router schemas remain available to import type",
      code: `import type { agentsMainContract } from "${agentsSource}"; type Body = typeof agentsMainContract.create.body;`,
      options,
    },
    {
      name: "type-only independent bindings stay on the original source",
      code: `import type { agentVisibilitySchema } from "${agentsSource}"; type Visibility = typeof agentVisibilitySchema;`,
      options,
    },
    ...runtimeBarrels.map((source) => ({
      name: `explicit type-only barrel imports remain valid: ${source}`,
      code: `import type { agentsMainContract } from "${source}"; type Router = typeof agentsMainContract;`,
      options,
    })),
    {
      name: "type-only namespace imports retain original route schemas",
      code: `import type * as contracts from "${agentsSource}"; type Body = typeof contracts.agentsMainContract.create.body;`,
      options,
    },
    {
      name: "type-only namespace barrel imports are erased",
      code: 'import type * as contracts from "@okouai/api-contracts"; type Contract = typeof contracts.agentsMainContract;',
      options,
    },
    {
      name: "named type reexports are erased",
      code: `export type { agentsMainContract } from "${agentsSource}";`,
      options,
    },
    {
      name: "type-only star reexports are erased",
      code: `export type * from "${agentsSource}";`,
      options,
    },
    {
      name: "import-type queries do not load runtime schemas",
      code: `type Router = typeof import("${agentsSource}").agentsMainContract;`,
      options,
    },
    {
      name: "import types from barrels remain erased",
      code: 'type Router = typeof import("@okouai/api-contracts/contracts").agentsMainContract;',
      options,
    },
    {
      name: "legacy core import types remain erased",
      code: 'type Router = typeof import("@okouai/core/contracts").agentsMainContract;',
      options,
    },
    {
      name: "legacy core type reexports remain erased",
      code: 'export type { agentsMainContract } from "@okouai/core";',
      options,
    },
    {
      name: "locally shadowed require functions are not runtime module loads",
      code: `function load(require: (source: string) => unknown) { return require("${agentsSource}"); }`,
      options,
    },
    {
      name: "similar package names are not api-contracts",
      code: 'import { agentsMainContract } from "other-api-contracts/contracts/agents"; consume(agentsMainContract);',
      options,
    },
    {
      name: "same-basename local files outside contractsDirectory are unrelated",
      code: 'import { agentsMainContract } from "./contracts/agents.ts"; consume(agentsMainContract);',
      options,
    },
    {
      name: "unrelated original imports are not matched by a name prefix",
      code: 'import { agentsMainContract } from "@okouai/api-contracts/contracts/agents-extra"; consume(agentsMainContract);',
      options,
    },
  ],
  invalid: [
    safeRouterCase(
      "direct proven signal factory",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
const client$ = computed((get) => get(apiClient$)(agentsMainContract));`,
    ),
    manualCase(
      "the non-public CCState get import is not a trusted getter API",
      `import { agentsMainContract } from "${agentsSource}";
import { get } from "ccstate";
import { apiClient$ } from "./signals/api-client.ts";
const client = get(apiClient$)(agentsMainContract);`,
    ),
    safeRouterCase(
      "an aliased computed import and getter resolve through their bindings",
      `import { agentsMainContract } from "${agentsSource}";
import { computed as derive } from "ccstate";
import { apiClient$ as factory$ } from "./signals/api-client.ts";
const client$ = derive((read) => read(factory$)(agentsMainContract));`,
    ),
    safeRouterCase(
      "a command context getter proves factory consumption",
      `import { agentsMainContract } from "${agentsSource}";
import { command } from "ccstate";
import { apiClient$ } from "./signals/api-client.ts";
const action = command(({ get }) => get(apiClient$)(agentsMainContract));`,
    ),
    safeRouterCase(
      "a command may also destructure its ordinary setter binding",
      `import { agentsMainContract } from "${agentsSource}";
import { command } from "ccstate";
import { apiClient$ } from "./signals/api-client.ts";
const action = command(({ get, set }) => get(apiClient$)(agentsMainContract));`,
    ),
    safeRouterCase(
      "a renamed getter remains proven alongside a setter",
      `import { agentsMainContract } from "${agentsSource}";
import { command } from "ccstate";
import { apiClient$ } from "./signals/api-client.ts";
const action = command(({ get: read, set: write }) => read(apiClient$)(agentsMainContract));`,
    ),
    safeRouterCase(
      "an aliased command context getter is resolved by its binding",
      `import { agentsMainContract } from "${agentsSource}";
import { command } from "ccstate";
import { apiClient$ } from "./signals/api-client.ts";
const action = command(({ get: read }) => read(apiClient$)(agentsMainContract));`,
    ),
    safeRouterCase(
      "a static string get property proves the command getter binding",
      `import { agentsMainContract } from "${agentsSource}";
import { command } from "ccstate";
import { apiClient$ } from "./signals/api-client.ts";
const action = command(({ "get": read }) => read(apiClient$)(agentsMainContract));`,
    ),
    safeRouterCase(
      "immutable command getter and factory aliases retain their proven origin",
      `import { agentsMainContract } from "${agentsSource}";
import { command as createCommand } from "ccstate";
import { apiClient$ } from "./signals/api-client.ts";
const makeCommand = createCommand;
const action = makeCommand(({ get }) => {
  const read = get;
  const createClient = read(apiClient$);
  const create = createClient;
  return create(agentsMainContract);
});`,
    ),
    {
      ...safeRouterCase(
        "signal modules resolve the adjacent trusted api-client file",
        `import { agentsMainContract } from "${agentsSource}";
import { computed } from "ccstate";
import { apiClient$ } from "./api-client.ts";
const client$ = computed((get) => get(apiClient$)(agentsMainContract));`,
      ),
      filename: "/repo/turbo/apps/platform/src/signals/example.ts",
    },
    ...[
      "./signals/api-client.js",
      "./signals/api-client",
      "/repo/turbo/apps/platform/src/signals/api-client.ts",
    ].map((source) =>
      safeRouterCase(
        `the exact trusted signal origin resolves without filesystem access: ${source}`,
        `import { agentsMainContract } from "${agentsSource}";
import { computed } from "ccstate";
import { apiClient$ } from "${source}";
const client$ = computed((get) => get(apiClient$)(agentsMainContract));`,
      ),
    ),
    safeRouterCase(
      "immutable factory alias inside a signal",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
const client$ = computed((get) => {
  const createClient = get(apiClient$);
  return createClient(agentsMainContract);
});`,
    ),
    safeRouterCase(
      "immutable factory alias chains resolve to their origin",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
const client$ = computed((get) => {
  const createClient = get(apiClient$);
  const create = createClient;
  return create(agentsMainContract);
});`,
    ),
    safeRouterCase(
      "router and signal import aliases retain their local names",
      `import { agentsMainContract as router } from "${agentsSource}";
import { computed as derive } from "ccstate";
import { apiClient$ as factory$ } from "./signals/api-client.ts";
const client$ = derive((read) => read(factory$)(router));`,
    ),
    safeRouterCase(
      "immutable router aliases retain proven safe uses",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
const router = agentsMainContract;
const client$ = computed((get) => get(apiClient$)(router));`,
    ),
    safeRouterCase(
      "metadata-only method path and content type accesses",
      `import { agentsMainContract } from "${agentsSource}";
const method = agentsMainContract.list.method;
const path = agentsMainContract.list.path;
const contentType = agentsMainContract.create.contentType;`,
    ),
    safeRouterCase(
      "safe client consumption and metadata access can coexist",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
const client$ = computed((get) => get(apiClient$)(agentsMainContract));
const path = agentsMainContract.list.path;`,
    ),
    safeRouterCase(
      "a shadowed router binding is not an unsafe reference to the import",
      `import { agentsMainContract as router } from "${agentsSource}";
const path = router.list.path;
function validate(router: { parse(value: unknown): unknown }) {
  return router.parse(input);
}`,
    ),
    safeRouterCase(
      "shadowed factory names in unrelated scopes do not taint safe uses",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
const client$ = computed((get) => get(apiClient$)(agentsMainContract));
function unrelated(get: (value: unknown) => unknown, apiClient$: unknown) {
  return get(apiClient$);
}`,
    ),
    safeRouterCase(
      "transport client with static default validation options",
      `import { agentsMainContract } from "${agentsSource}";
${transportImport}
const client = initClient(agentsMainContract, { baseUrl: "/api" });`,
    ),
    safeRouterCase(
      "transport client with explicit validation disabled",
      `import { agentsMainContract } from "${agentsSource}";
${transportImport}
const client = initClient(agentsMainContract, { baseUrl: "/api", validateResponse: false });`,
    ),
    safeRouterCase(
      "aliased transport import is resolved by binding",
      `import { agentsMainContract } from "${agentsSource}";
import { initClient as create } from "@okouai/api-contracts/client/transport";
const client = create(agentsMainContract, { baseUrl: "/api" });`,
    ),
    safeRouterCase(
      "leading and trailing comments survive a source-only redirect",
      `// Contract metadata for the link.
import { agentsMainContract } from "${agentsSource}"; // Preserve this note.
const path = agentsMainContract.list.path;`,
    ),
    safeRouterCase(
      "inline binding comments survive a source-only redirect",
      `import { /* Preserve the router note. */ agentsMainContract } from "${agentsSource}";
const path = agentsMainContract.list.path;`,
    ),
    {
      name: "billing routers use their own descriptor module",
      code: `import { billingMainContract } from "${billingSource}"; const path = billingMainContract.list.path;`,
      options,
      errors: [{ messageId: "preferClient" }],
      output:
        'import { billingMainContract } from "@okouai/api-contracts/client/billing"; const path = billingMainContract.list.path;',
    },
    ...[".ts", ".js", ""].map((extension) => {
      const source = `../../../packages/api-contracts/src/contracts/agents${extension}`;
      const code = `import { agentsMainContract } from "${source}"; const path = agentsMainContract.list.path;`;
      return {
        name: `relative router paths preserve their extension: ${extension || "none"}`,
        code,
        options,
        errors: [{ messageId: "preferClient" as const }],
        output: code.replace("/contracts/agents", "/client/agents"),
      };
    }),
    {
      name: "absolute router paths resolve without reading the filesystem",
      code: `import { agentsMainContract } from "${contractsDirectory}/agents.ts"; const path = agentsMainContract.list.path;`,
      options,
      errors: [{ messageId: "preferClient" }],
      output:
        'import { agentsMainContract } from "/repo/turbo/packages/api-contracts/src/client/agents.ts"; const path = agentsMainContract.list.path;',
    },
    {
      name: "known schemas redirect without changing runtime parsing",
      code: `import { agentVisibilitySchema as visibility } from "${agentsSource}"; visibility.parse(input);`,
      options,
      errors: [{ messageId: "preferIndependent" }],
      output:
        'import { agentVisibilitySchema as visibility } from "@okouai/api-contracts/validators/agents"; visibility.parse(input);',
    },
    {
      name: "known constants redirect to independent owners",
      code: `import { AGENT_VISIBILITIES } from "${agentsSource}"; consume(AGENT_VISIBILITIES);`,
      options,
      errors: [{ messageId: "preferIndependent" }],
      output:
        'import { AGENT_VISIBILITIES } from "@okouai/api-contracts/validators/agents"; consume(AGENT_VISIBILITIES);',
    },
    {
      name: "independent relative paths preserve the local alias and extension",
      code: 'import { billingCurrencySchema as currency } from "../../../packages/api-contracts/src/contracts/billing.js"; currency.parse(input);',
      options,
      errors: [{ messageId: "preferIndependent" }],
      output:
        'import { billingCurrencySchema as currency } from "../../../packages/api-contracts/src/validators/billing.js"; currency.parse(input);',
    },
    ...["body", "responses", "pathParams", "query", "headers"].map((property) =>
      manualCase(
        `route schema access must not lose validation: ${property}`,
        `import { agentsMainContract } from "${agentsSource}"; consume(agentsMainContract.create.${property});`,
      ),
    ),
    manualCase(
      "schema parsing is not metadata consumption",
      `import { agentsMainContract } from "${agentsSource}"; agentsMainContract.create.body.parse(input);`,
    ),
    manualCase(
      "response validation is retained",
      `import { agentsMainContract } from "${agentsSource}"; agentsMainContract.list.responses[200].parse(response);`,
    ),
    manualCase(
      "one unsafe runtime reference prevents migrating safe references",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
const client$ = computed((get) => get(apiClient$)(agentsMainContract));
agentsMainContract.create.body.parse(input);`,
    ),
    manualCase(
      "mixed router bindings are not partially rewritten unsafely",
      `import { agentsMainContract, agentsByIdContract } from "${agentsSource}";
const path = agentsMainContract.list.path;
agentsByIdContract.update.body.parse(input);`,
    ),
    manualCase(
      "a runtime router with original schema type queries is not replaced",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
type Body = typeof agentsMainContract.create.body;
const client$ = computed((get) => get(apiClient$)(agentsMainContract));`,
    ),
    manualCase(
      "annotated router aliases can still require the full server contract type",
      `import { agentsMainContract } from "${agentsSource}";
import type { AppRouter } from "@okouai/api-contracts/contracts/trpc-contract";
${transportImport}
const router: AppRouter = agentsMainContract;
const client = initClient(router, { baseUrl: "/api" });`,
    ),
    manualCase(
      "annotated factory aliases can narrow their argument back to AppRouter",
      `import { agentsMainContract } from "${agentsSource}";
import type { AppRouter } from "@okouai/api-contracts/contracts/trpc-contract";
${signalImports}
const client$ = computed((get) => {
  const factory: (router: AppRouter) => unknown = get(apiClient$);
  return factory(agentsMainContract);
});`,
    ),
    manualCase(
      "annotated computed getter parameters require type-aware migration",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
const client$ = computed((get: CustomGetter) => get(apiClient$)(agentsMainContract));`,
    ),
    manualCase(
      "annotated command context parameters require type-aware migration",
      `import { agentsMainContract } from "${agentsSource}";
import { command } from "ccstate";
import { apiClient$ } from "./signals/api-client.ts";
const action = command(({ get }: CustomContext) => get(apiClient$)(agentsMainContract));`,
    ),
    manualCase(
      "explicit transport generic arguments may still require AppRouter",
      `import { agentsMainContract } from "${agentsSource}";
import type { AppRouter } from "@okouai/api-contracts/contracts/trpc-contract";
${transportImport}
const client = initClient<AppRouter>(agentsMainContract, { baseUrl: "/api" });`,
    ),
    manualCase(
      "explicit signal factory generic arguments may still require AppRouter",
      `import { agentsMainContract } from "${agentsSource}";
import type { AppRouter } from "@okouai/api-contracts/contracts/trpc-contract";
${signalImports}
const client$ = computed((get) => get(apiClient$)<AppRouter>(agentsMainContract));`,
    ),
    manualCase(
      "unknown factories require manual migration",
      `import { agentsMainContract } from "${agentsSource}"; const client = createClient(agentsMainContract);`,
    ),
    manualCase(
      "ApiClientFactory parameter annotations do not prove the runtime origin",
      `import { agentsMainContract } from "${agentsSource}";
import type { ApiClientFactory } from "./signals/api-client.ts";
function create(factory: ApiClientFactory) { return factory(agentsMainContract); }`,
    ),
    manualCase(
      "matching free getter names do not prove a CCState factory",
      `import { agentsMainContract } from "${agentsSource}";
import { apiClient$ } from "./signals/api-client.ts";
const client = get(apiClient$)(agentsMainContract);`,
    ),
    manualCase(
      "arbitrary function getter parameters do not prove a CCState factory",
      `import { agentsMainContract } from "${agentsSource}";
import { apiClient$ } from "./signals/api-client.ts";
function create(get: (signal: unknown) => (router: unknown) => unknown) {
  return get(apiClient$)(agentsMainContract);
}`,
    ),
    ...["./other/api-client.ts", "@okouai/platform/signals/api-client"].map(
      (source) =>
        manualCase(
          `a matching apiClient$ name does not prove the trusted signal origin: ${source}`,
          `import { agentsMainContract } from "${agentsSource}";
import { computed } from "ccstate";
import { apiClient$ } from "${source}";
const client$ = computed((get) => get(apiClient$)(agentsMainContract));`,
        ),
    ),
    manualCase(
      "an unknown callback owner cannot certify a destructured getter",
      `import { agentsMainContract } from "${agentsSource}";
import { apiClient$ } from "./signals/api-client.ts";
const action = unknownCommand(({ get }) => get(apiClient$)(agentsMainContract));`,
    ),
    ...[
      { name: "misnamed getter", parameter: "{ read }", getter: "read" },
      {
        name: "property default",
        parameter: "{ get = unknownGetter }",
        getter: "get",
      },
      {
        name: "parameter default",
        parameter: "{ get } = fallback",
        getter: "get",
      },
      { name: "rest binding", parameter: "{ get, ...rest }", getter: "get" },
      {
        name: "computed property",
        parameter: '{ ["get"]: get }',
        getter: "get",
      },
    ].map(({ name, parameter, getter }) =>
      manualCase(
        `command getter proof rejects ambiguous context patterns: ${name}`,
        `import { agentsMainContract } from "${agentsSource}";
import { command } from "ccstate";
import { apiClient$ } from "./signals/api-client.ts";
const action = command((${parameter}) => ${getter}(apiClient$)(agentsMainContract));`,
      ),
    ),
    manualCase(
      "mutable command aliases do not establish callback provenance",
      `import { agentsMainContract } from "${agentsSource}";
import { command } from "ccstate";
import { apiClient$ } from "./signals/api-client.ts";
let makeCommand = command;
const action = makeCommand(({ get }) => get(apiClient$)(agentsMainContract));`,
    ),
    manualCase(
      "reassigned command aliases do not establish callback provenance",
      `import { agentsMainContract } from "${agentsSource}";
import { command } from "ccstate";
import { apiClient$ } from "./signals/api-client.ts";
let makeCommand = command;
makeCommand = unknownCommand;
const action = makeCommand(({ get }) => get(apiClient$)(agentsMainContract));`,
    ),
    manualCase(
      "a reassigned command getter cannot establish the factory origin",
      `import { agentsMainContract } from "${agentsSource}";
import { command } from "ccstate";
import { apiClient$ } from "./signals/api-client.ts";
const action = command(({ get }) => {
  get = unknownGetter;
  return get(apiClient$)(agentsMainContract);
});`,
    ),
    manualCase(
      "a mutable getter alias cannot establish the factory origin",
      `import { agentsMainContract } from "${agentsSource}";
import { command } from "ccstate";
import { apiClient$ } from "./signals/api-client.ts";
const action = command(({ get }) => {
  let read = get;
  read = unknownGetter;
  return read(apiClient$)(agentsMainContract);
});`,
    ),
    manualCase(
      "the trusted signal factory does not authorize additional options arguments",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
const client$ = computed((get) => get(apiClient$)(agentsMainContract, { apiBase: "api" }));`,
    ),
    manualCase(
      "a callback getter shadowed by an inner parameter is unsafe",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
const client$ = computed((get) => {
  function create(get: (value: unknown) => (router: unknown) => unknown) {
    return get(apiClient$)(agentsMainContract);
  }
  return create;
});`,
    ),
    manualCase(
      "a shadowed apiClient$ is not the imported signal",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
const client$ = computed((get) => {
  function create(apiClient$: unknown) { return get(apiClient$)(agentsMainContract); }
  return create;
});`,
    ),
    manualCase(
      "a shadowed computed is not a CCState callback owner",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
function create(computed: (callback: unknown) => unknown) {
  return computed((get: (value: unknown) => (router: unknown) => unknown) => get(apiClient$)(agentsMainContract));
}`,
    ),
    manualCase(
      "mutable factory aliases cannot prove safe consumption",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
const client$ = computed((get) => {
  let create = get(apiClient$);
  create = unknownFactory;
  return create(agentsMainContract);
});`,
    ),
    manualCase(
      "let factory aliases are not treated as immutable origin proofs",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
const client$ = computed((get) => {
  let create = get(apiClient$);
  return create(agentsMainContract);
});`,
    ),
    manualCase(
      "mutable router aliases cannot prove all downstream uses",
      `import { agentsMainContract } from "${agentsSource}";
${signalImports}
let router = agentsMainContract;
router = otherRouter;
const client$ = computed((get) => get(apiClient$)(router));`,
    ),
    manualCase(
      "unsafe uses reached through immutable router aliases remain unsafe",
      `import { agentsMainContract } from "${agentsSource}";
const router = agentsMainContract;
router.create.body.parse(input);`,
    ),
    ...[
      '{ baseUrl: "/api", validateResponse: true }',
      '{ baseUrl: "/api", validateResponse: shouldValidate }',
      '{ baseUrl: "/api", ...config }',
      '{ baseUrl: "/api", [option]: false }',
      "config",
    ].map((config) =>
      manualCase(
        `transport validation must be statically safe: ${config}`,
        `import { agentsMainContract } from "${agentsSource}";
${transportImport}
const client = initClient(agentsMainContract, ${config});`,
      ),
    ),
    manualCase(
      "custom transport fetchers may inspect full route schemas",
      `import { agentsMainContract } from "${agentsSource}";
${transportImport}
const client = initClient(agentsMainContract, { baseUrl: "/api", api: customFetcher });`,
    ),
    manualCase(
      "an explicit third validation argument is not dropped",
      `import { agentsMainContract } from "${agentsSource}";
${transportImport}
const client = initClient(agentsMainContract, { baseUrl: "/api" }, validateResponse);`,
    ),
    manualCase(
      "legacy validating transport must not silently become schema-free",
      `import { agentsMainContract } from "${agentsSource}";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
const client = initClient(agentsMainContract, { baseUrl: "/api" });`,
    ),
    manualCase(
      "a shadowed initClient does not inherit the import origin",
      `import { agentsMainContract } from "${agentsSource}";
${transportImport}
function create(initClient: (router: unknown, options: unknown) => unknown) {
  return initClient(agentsMainContract, { baseUrl: "/api" });
}`,
    ),
    manualCase(
      "storing a full router is not proven HTTP consumption",
      `import { agentsMainContract } from "${agentsSource}"; const config = { router: agentsMainContract };`,
    ),
    manualCase(
      "local router reexports preserve full schema semantics",
      `import { agentsMainContract } from "${agentsSource}"; export { agentsMainContract };`,
    ),
    manualCase(
      "dynamic router member names cannot prove metadata-only access",
      `import { agentsMainContract } from "${agentsSource}"; const path = agentsMainContract[route].path;`,
    ),
    manualCase(
      "nested metadata-looking chains may cross original schema fields",
      `import { agentsMainContract } from "${agentsSource}"; consume(agentsMainContract.create.body.path);`,
    ),
    manualCase(
      "metadata writes are not metadata-only reads",
      `import { agentsMainContract } from "${agentsSource}"; agentsMainContract.list.path = "/custom";`,
    ),
    manualCase(
      "destructuring assignments to route metadata are not reads",
      `import { agentsMainContract } from "${agentsSource}"; ({ path: agentsMainContract.list.path } = input);`,
    ),
    manualCase(
      "calling a member named path is not metadata consumption",
      `import { agentsMainContract } from "${agentsSource}"; agentsMainContract.list.path();`,
    ),
    manualCase(
      "unused router imports are not blindly converted to import type",
      `import { agentsMainContract } from "${agentsSource}"; export const answer = 42;`,
    ),
    manualCase(
      "unknown runtime exports fail closed when metadata is incomplete",
      `import { unknownSchema } from "${agentsSource}"; unknownSchema.parse(input);`,
    ),
    manualCase(
      "unknown bindings prevent an unsafe mixed-source rewrite",
      `import { agentVisibilitySchema, unknownSchema } from "${agentsSource}"; agentVisibilitySchema.parse(input); unknownSchema.parse(input);`,
    ),
    {
      ...manualCase(
        "independent metadata cannot redirect to another router-bearing module",
        `import { agentVisibilitySchema } from "${agentsSource}"; agentVisibilitySchema.parse(input);`,
      ),
      options: [
        {
          ...ruleOptions,
          modules: ruleOptions.modules.map((module) =>
            module.module === "agents"
              ? {
                  ...module,
                  bindings: [
                    {
                      name: "agentVisibilitySchema",
                      source: "contracts/billing",
                      imported: "billingCurrencySchema",
                    },
                  ],
                }
              : module,
          ),
        },
      ],
    },
    ...runtimeBarrels.map((source) =>
      manualCase(
        `runtime barrel bindings require an explicit source decision: ${source}`,
        `import { agentsMainContract } from "${source}"; const path = agentsMainContract.list.path;`,
      ),
    ),
    runtimeCase(
      "namespace contract imports load runtime schemas",
      `import * as contracts from "${agentsSource}"; consume(contracts.agentsMainContract);`,
    ),
    runtimeCase(
      "default contract imports are not guessed",
      `import contracts from "${agentsSource}"; consume(contracts);`,
    ),
    runtimeCase(
      "side-effect contract imports load runtime schemas",
      `import "${agentsSource}";`,
    ),
    runtimeCase(
      "literal dynamic imports load runtime schemas",
      `const contracts = await import("${agentsSource}");`,
    ),
    runtimeCase(
      "literal require calls load runtime schemas",
      `const contracts = require("${agentsSource}");`,
    ),
    runtimeCase(
      "TypeScript import-equals requires load runtime schemas",
      `import contracts = require("${agentsSource}"); consume(contracts);`,
    ),
    runtimeCase(
      "named runtime reexports load full contracts",
      `export { agentsMainContract } from "${agentsSource}";`,
    ),
    runtimeCase(
      "star runtime reexports load full contracts",
      `export * from "${agentsSource}";`,
    ),
    runtimeCase(
      "namespace runtime reexports load full contracts",
      `export * as contracts from "${agentsSource}";`,
    ),
    runtimeCase(
      "relative dynamic imports are resolved against the current file",
      'const contracts = await import("../../../packages/api-contracts/src/contracts/agents.ts");',
    ),
    runtimeCase(
      "absolute require imports are resolved without filesystem access",
      `const contracts = require("${contractsDirectory}/agents.js");`,
    ),
    runtimeCase(
      "root namespace imports are not exempt",
      'import * as contracts from "@okouai/api-contracts"; consume(contracts);',
    ),
    runtimeCase(
      "root bare imports are not exempt",
      'import "@okouai/api-contracts/contracts";',
    ),
    runtimeCase(
      "legacy core namespace barrels load original HTTP contracts",
      'import * as contracts from "@okouai/core"; consume(contracts);',
    ),
    runtimeCase(
      "legacy core dynamic imports load original HTTP contracts",
      'const contracts = await import("@okouai/core/contracts");',
    ),
    {
      ...manualCase(
        "production scope selection belongs to configs, not filename heuristics",
        `import { agentsMainContract } from "${agentsSource}"; consume(agentsMainContract);`,
      ),
      filename: "/repo/turbo/apps/platform/src/example.test.ts",
    },
  ],
});

interface ImportBinding {
  source: string;
  imported: string;
  local: string;
  kind: "type" | "value";
}

function parseCode(code: string): ts.SourceFile {
  return ts.createSourceFile(
    filename,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function importsIn(code: string): ImportBinding[] {
  return parseCode(code).statements.flatMap((node) => {
    if (
      !ts.isImportDeclaration(node) ||
      node.importClause === undefined ||
      !ts.isStringLiteral(node.moduleSpecifier)
    ) {
      return [];
    }
    const source = node.moduleSpecifier.text;
    const clause = node.importClause;
    const bindings: ImportBinding[] = [];
    if (clause.name !== undefined) {
      bindings.push(
        binding(
          source,
          "default",
          clause.name.text,
          clause.isTypeOnly ? "type" : "value",
        ),
      );
    }
    const named = clause.namedBindings;
    if (named !== undefined) {
      if (ts.isNamespaceImport(named)) {
        bindings.push(
          binding(
            source,
            "*",
            named.name.text,
            clause.isTypeOnly ? "type" : "value",
          ),
        );
      } else {
        for (const specifier of named.elements) {
          bindings.push(
            binding(
              source,
              specifier.propertyName?.text ?? specifier.name.text,
              specifier.name.text,
              clause.isTypeOnly || specifier.isTypeOnly ? "type" : "value",
            ),
          );
        }
      }
    }
    return bindings;
  });
}

function expectErasedTypeOnlyGroups(code: string): void {
  for (const node of parseCode(code).statements) {
    if (!ts.isImportDeclaration(node)) {
      continue;
    }
    expect(node.importClause).toBeDefined();
    const clause = node.importClause;
    const named = clause?.namedBindings;
    if (
      named !== undefined &&
      ts.isNamedImports(named) &&
      named.elements.length > 0 &&
      named.elements.every((specifier) => specifier.isTypeOnly)
    ) {
      expect(clause?.isTypeOnly).toBe(true);
    }
  }
}

function nonImportStatements(code: string): string[] {
  const ast = parseCode(code);
  return ast.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => code.slice(node.getStart(ast), node.end));
}

const linter = new TSESLint.Linter({ cwd: "/repo" });
const config: TSESLint.FlatConfig.Config = {
  files: ["**/*.ts"],
  languageOptions: { parser, ecmaVersion: "latest", sourceType: "module" },
  plugins: {
    "client-contracts": {
      rules: { "prefer-client-descriptors": preferClientDescriptors },
    },
  },
  rules: {
    "client-contracts/prefer-client-descriptors": ["error", ruleOptions],
  },
};

function binding(
  source: string,
  imported: string,
  local = imported,
  kind: ImportBinding["kind"] = "value",
): ImportBinding {
  return { source, imported, local, kind };
}

function expectStableFix(
  code: string,
  messageId: "preferClient" | "preferIndependent" | "typeOnly",
  bindings: ImportBinding[],
): void {
  const messages = linter.verify(code, config, { filename });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    messageId,
    fix: expect.objectContaining({}),
  });
  const result = linter.verifyAndFix(code, config, { filename });
  expect(result.fixed).toBe(true);
  expect(result.messages).toEqual([]);
  expect(importsIn(result.output)).toHaveLength(bindings.length);
  expect(importsIn(result.output)).toEqual(expect.arrayContaining(bindings));
  expectErasedTypeOnlyGroups(result.output);
  expect(nonImportStatements(result.output)).toEqual(nonImportStatements(code));
  const repeated = linter.verifyAndFix(result.output, config, { filename });
  expect(repeated).toMatchObject({
    fixed: false,
    output: result.output,
    messages: [],
  });
}

function expectCollisionFixOrReport(
  code: string,
  messageIds: string[],
  bindings: ImportBinding[],
): void {
  const messages = linter.verify(code, config, { filename });
  expect(messages.map((message) => message.messageId)).toEqual(messageIds);
  const result = linter.verifyAndFix(code, config, { filename });
  expect(nonImportStatements(result.output)).toEqual(nonImportStatements(code));
  if (result.fixed) {
    expect(result.messages).toEqual([]);
    expect(importsIn(result.output)).toHaveLength(bindings.length);
    expect(importsIn(result.output)).toEqual(expect.arrayContaining(bindings));
    expectErasedTypeOnlyGroups(result.output);
    const declarations = parseCode(result.output).statements.flatMap((node) => {
      if (
        !ts.isImportDeclaration(node) ||
        !ts.isStringLiteral(node.moduleSpecifier)
      ) {
        return [];
      }
      return [
        JSON.stringify([
          node.moduleSpecifier.text,
          node.importClause?.isTypeOnly === true,
        ]),
      ];
    });
    expect(new Set(declarations).size).toBe(declarations.length);
  } else {
    expect(result.output).toBe(code);
    expect(result.messages).toHaveLength(messageIds.length);
    for (const message of result.messages) {
      expect(message.fix).toBeUndefined();
    }
  }
  const repeated = linter.verifyAndFix(result.output, config, { filename });
  expect(repeated.fixed).toBe(false);
  expect(repeated.output).toBe(result.output);
}

// Import grouping is flexible, but type-only groups must still be fully erased.
describe("prefer-client-descriptors semantic autofixes", () => {
  it("keeps original schemas available when all imported references are type-only", () => {
    expectStableFix(
      `import { agentsMainContract as original } from "${agentsSource}";
type Body = typeof original.create.body;`,
      "typeOnly",
      [binding(agentsSource, "agentsMainContract", "original", "type")],
    );
  });

  it("makes all-inline-type imports fully erased under verbatimModuleSyntax", () => {
    expectStableFix(
      `import { type agentsMainContract as original } from "${agentsSource}";
type Responses = typeof original.list.responses;`,
      "typeOnly",
      [binding(agentsSource, "agentsMainContract", "original", "type")],
    );
  });

  it("erases explicitly type-only imports even when their binding is unused", () => {
    expectStableFix(
      `import { type agentsMainContract } from "${agentsSource}";
export const answer = 42;`,
      "typeOnly",
      [
        binding(
          agentsSource,
          "agentsMainContract",
          "agentsMainContract",
          "type",
        ),
      ],
    );
  });

  it("does not treat all-inline-type reexports as fully erased runtime syntax", () => {
    const code = `export { type agentsMainContract } from "${agentsSource}";`;
    const messages = linter.verify(code, config, { filename });
    expect(messages).toHaveLength(1);
    expect(["typeOnly", "runtimeImport"]).toContain(messages[0].messageId);
    const result = linter.verifyAndFix(code, config, { filename });
    if (result.fixed) {
      expect(result.messages).toEqual([]);
      const ast = parseCode(result.output);
      expect(ast.statements).toHaveLength(1);
      const declaration = ast.statements[0];
      if (!ts.isExportDeclaration(declaration)) {
        throw new Error(
          "Expected the fixed code to retain a type-only reexport.",
        );
      }
      expect(declaration.isTypeOnly).toBe(true);
      const source = declaration.moduleSpecifier;
      if (source === undefined || !ts.isStringLiteral(source)) {
        throw new Error("Expected the original reexport source.");
      }
      expect(source.text).toBe(agentsSource);
      const clause = declaration.exportClause;
      if (clause === undefined || !ts.isNamedExports(clause)) {
        throw new Error("Expected named type-only reexports.");
      }
      expect(clause.elements).toHaveLength(1);
      expect(clause.elements[0].name.text).toBe("agentsMainContract");
      expect(
        clause.elements[0].propertyName?.text ?? clause.elements[0].name.text,
      ).toBe("agentsMainContract");
    } else {
      expect(result.output).toBe(code);
      expect(result.messages[0].fix).toBeUndefined();
    }
    const repeated = linter.verifyAndFix(result.output, config, { filename });
    expect(repeated.fixed).toBe(false);
    expect(repeated.output).toBe(result.output);
  });

  it("allows type-only imports from barrels without redirecting their schema queries", () => {
    const source = "@okouai/api-contracts";
    expectStableFix(
      `import { agentsMainContract } from "${source}";
type Body = typeof agentsMainContract.create.body;`,
      "typeOnly",
      [binding(source, "agentsMainContract", "agentsMainContract", "type")],
    );
  });

  it("does not confuse a shadowed runtime parameter with an imported type reference", () => {
    expectStableFix(
      `import { agentsMainContract as original } from "${agentsSource}";
type Body = typeof original.create.body;
function read(original: { value: number }) { return original.value; }`,
      "typeOnly",
      [binding(agentsSource, "agentsMainContract", "original", "type")],
    );
  });

  it("splits original router types from independent runtime validators", () => {
    expectStableFix(
      `import { agentsMainContract as original, agentVisibilitySchema as visibility } from "${agentsSource}";
type Body = typeof original.create.body;
visibility.parse(input);`,
      "preferIndependent",
      [
        binding(agentsSource, "agentsMainContract", "original", "type"),
        binding(
          "@okouai/api-contracts/validators/agents",
          "agentVisibilitySchema",
          "visibility",
        ),
      ],
    );
  });

  it("splits descriptor values independent validators and explicit original types", () => {
    expectStableFix(
      `import { agentsMainContract as router, agentVisibilitySchema as visibility, type AgentInput } from "${agentsSource}";
const path = router.list.path;
visibility.parse(input);
type Input = AgentInput;`,
      "preferClient",
      [
        binding(
          "@okouai/api-contracts/client/agents",
          "agentsMainContract",
          "router",
        ),
        binding(
          "@okouai/api-contracts/validators/agents",
          "agentVisibilitySchema",
          "visibility",
        ),
        binding(agentsSource, "AgentInput", "AgentInput", "type"),
      ],
    );
  });

  it("preserves explicit original schema queries alongside a separate descriptor binding", () => {
    expectStableFix(
      `import { agentsMainContract as router, type agentsMainContract as Original } from "${agentsSource}";
const path = router.list.path;
type Body = typeof Original.create.body;`,
      "preferClient",
      [
        binding(
          "@okouai/api-contracts/client/agents",
          "agentsMainContract",
          "router",
        ),
        binding(agentsSource, "agentsMainContract", "Original", "type"),
      ],
    );
  });

  it("redirects renamed defining exports while preserving local aliases", () => {
    expectStableFix(
      `import { chatThreadDraftSchema as draft, agentVisibilitySchema as visibility } from "${agentsSource}";
draft.parse(input);
visibility.parse(input);`,
      "preferIndependent",
      [
        binding(
          "@okouai/api-contracts/validators/draft-composer",
          "composerDraftSchema",
          "draft",
        ),
        binding(
          "@okouai/api-contracts/validators/agents",
          "agentVisibilitySchema",
          "visibility",
        ),
      ],
    );
  });

  it("adds a local alias when the defining export has a different public name", () => {
    expectStableFix(
      `import { chatThreadDraftSchema } from "${agentsSource}";
chatThreadDraftSchema.parse(input);`,
      "preferIndependent",
      [
        binding(
          "@okouai/api-contracts/validators/draft-composer",
          "composerDraftSchema",
          "chatThreadDraftSchema",
        ),
      ],
    );
  });

  it("redirects independent symbols used in both runtime validation and type queries", () => {
    expectStableFix(
      `import { agentVisibilitySchema as visibility } from "${agentsSource}";
visibility.parse(input);
type Schema = typeof visibility;`,
      "preferIndependent",
      [
        binding(
          "@okouai/api-contracts/validators/agents",
          "agentVisibilitySchema",
          "visibility",
        ),
      ],
    );
  });

  it("preserves every binding when several independent names share a destination", () => {
    expectStableFix(
      `import { AGENT_VISIBILITIES as values, agentVisibilitySchema as schema } from "${agentsSource}";
consume(values);
schema.parse(input);`,
      "preferIndependent",
      [
        binding(
          "@okouai/api-contracts/validators/agents",
          "AGENT_VISIBILITIES",
          "values",
        ),
        binding(
          "@okouai/api-contracts/validators/agents",
          "agentVisibilitySchema",
          "schema",
        ),
      ],
    );
  });

  it("moves runtime bindings while retaining an existing original type-only declaration", () => {
    expectStableFix(
      `import type { AgentInput } from "${agentsSource}";
import { agentsMainContract } from "${agentsSource}";
const path = agentsMainContract.list.path;
type Input = AgentInput;`,
      "preferClient",
      [
        binding(agentsSource, "AgentInput", "AgentInput", "type"),
        binding(
          "@okouai/api-contracts/client/agents",
          "agentsMainContract",
          "agentsMainContract",
        ),
      ],
    );
  });

  it("merges an existing destination import or refuses to create duplicate value imports", () => {
    const destination = "@okouai/api-contracts/client/agents";
    expectCollisionFixOrReport(
      `import { agentsByIdContract as existing } from "${destination}";
import { agentsMainContract as router } from "${agentsSource}";
const existingPath = existing.get.path;
const path = router.list.path;`,
      ["preferClient"],
      [
        binding(destination, "agentsByIdContract", "existing"),
        binding(destination, "agentsMainContract", "router"),
      ],
    );
  });

  it("does not create duplicate independent imports through simultaneous legacy fixes", () => {
    expectCollisionFixOrReport(
      `import { agentVisibilitySchema as visibility } from "${agentsSource}";
import { agentVisibilitySchema as billingVisibility } from "${billingSource}";
visibility.parse(input);
billingVisibility.parse(input);`,
      ["preferIndependent", "preferIndependent"],
      [
        binding(
          "@okouai/api-contracts/validators/agents",
          "agentVisibilitySchema",
          "visibility",
        ),
        binding(
          "@okouai/api-contracts/validators/agents",
          "agentVisibilitySchema",
          "billingVisibility",
        ),
      ],
    );
  });

  it("does not duplicate original type-only imports while preserving schema queries", () => {
    expectCollisionFixOrReport(
      `import type { agentsMainContract as Existing } from "${agentsSource}";
import { agentsMainContract as Original } from "${agentsSource}";
type ExistingBody = typeof Existing.create.body;
type OriginalBody = typeof Original.create.body;`,
      ["typeOnly"],
      [
        binding(agentsSource, "agentsMainContract", "Existing", "type"),
        binding(agentsSource, "agentsMainContract", "Original", "type"),
      ],
    );
  });

  it("preserves comments and all mixed bindings or refuses to autofix", () => {
    const comments = [
      "// Original router note.",
      "/* Router metadata. */",
      "/* Runtime validation. */",
      "// Keep the validator.",
    ];
    const code = `${comments[0]}
import {
  ${comments[1]} agentsMainContract as router,
  ${comments[2]} agentVisibilitySchema as visibility,
} from "${agentsSource}"; ${comments[3]}
const path = router.list.path;
visibility.parse(input);`;
    const messages = linter.verify(code, config, { filename });
    expect(messages).toHaveLength(1);
    const result = linter.verifyAndFix(code, config, { filename });
    for (const comment of comments) {
      expect(result.output.split(comment)).toHaveLength(2);
    }
    expect(nonImportStatements(result.output)).toEqual(
      nonImportStatements(code),
    );
    if (result.fixed) {
      expect(result.messages).toEqual([]);
      expect(importsIn(result.output)).toHaveLength(2);
      expect(importsIn(result.output)).toEqual(
        expect.arrayContaining([
          binding(
            "@okouai/api-contracts/client/agents",
            "agentsMainContract",
            "router",
          ),
          binding(
            "@okouai/api-contracts/validators/agents",
            "agentVisibilitySchema",
            "visibility",
          ),
        ]),
      );
    } else {
      expect(result.output).toBe(code);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].fix).toBeUndefined();
    }
    const repeated = linter.verifyAndFix(result.output, config, { filename });
    expect(repeated.fixed).toBe(false);
    expect(repeated.output).toBe(result.output);
  });

  it("refuses import attributes rather than dropping them during a split", () => {
    const code = `import { agentsMainContract as router, agentVisibilitySchema as visibility } from "${agentsSource}" with { mode: "preserve" };
const path = router.list.path;
visibility.parse(input);`;
    const messages = linter.verify(code, config, { filename });
    expect(messages).toHaveLength(1);
    expect(["manualMigration", "preferClient"]).toContain(
      messages[0].messageId,
    );
    expect(messages[0].fix).toBeUndefined();
    expect(linter.verifyAndFix(code, config, { filename })).toMatchObject({
      fixed: false,
      output: code,
    });
  });
});
