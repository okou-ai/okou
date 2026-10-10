import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { maxSignalOwnerLines } from "../rules/max-signal-owner-lines.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const options: [{ max: number; owners: string[] }] = [
  { max: 4, owners: ["createClaimRunObjects"] },
];

ruleTester.run("max-signal-owner-lines", maxSignalOwnerLines, {
  valid: [
    {
      name: "counts graph callbacks independently of the declarative owner",
      options,
      code: `
        import { computed, command, state } from "ccstate";
        export function createClaimRunObjects(claim: { threadId: string }) {
          const revision$ = state(0);
          const event$ = computed(get => {
            get(revision$);
            return claim.threadId;
          });
          const prepare$ = command(({ get }) => {
            return get(event$);
          });
          return { event$, prepare$ };
        }
      `,
    },
    {
      name: "ignores blank and comment-only lines in operational code",
      options,
      code: `
        function shortOperation() {
          // A comment does not enlarge the operational function.

          return 1;
        }
      `,
    },
    {
      name: "recognizes imported constructor aliases",
      options,
      code: `
        import { computed as read, command as write } from "ccstate";
        function createClaimRunObjects(claim: { id: string }) {
          const value$ = read(() => claim.id);
          const result$ = read(get => get(value$));
          const run$ = write(({ get }) => get(result$));
          return { value$, result$, run$ };
        }
      `,
    },
  ],
  invalid: [
    {
      name: "still bounds each operational callback",
      options,
      code: `
        import { command } from "ccstate";
        function createClaimRunObjects() {
          const run$ = command(() => {
            const one = 1;
            const two = 2;
            const three = 3;
            return one + two + three;
          });
          return { run$ };
        }
      `,
      errors: [{ messageId: "tooLong" }],
    },
    {
      name: "does not exempt a similarly named imperative function",
      options,
      code: `
        function createClaimRunObjects() {
          writeToDatabase();
          const value = 1;
          const second = 2;
          return { value, second };
        }
      `,
      errors: [{ messageId: "tooLong" }],
    },
    {
      name: "does not exempt ordinary long functions",
      options,
      code: `
        function prepare() {
          const value = 1;
          const second = 2;
          const third = 3;
          return value + second + third;
        }
      `,
      errors: [{ messageId: "tooLong" }],
    },
    {
      name: "rejects eager work hidden in state initialization",
      options,
      code: `
        import { state } from "ccstate";
        function createClaimRunObjects() {
          const eager$ = state(readDatabase());
          const one$ = state(1);
          const two$ = state(2);
          return { eager$, one$, two$ };
        }
      `,
      errors: [{ messageId: "tooLong" }],
    },
    {
      name: "does not trust constructor names from other packages",
      options,
      code: `
        import { computed } from "other-package";
        function createClaimRunObjects() {
          const one$ = computed(() => 1);
          const two$ = computed(() => 2);
          const three$ = computed(() => 3);
          return { one$, two$, three$ };
        }
      `,
      errors: [{ messageId: "tooLong" }],
    },
  ],
});

const fixtureDirectory = mkdtempSync(join(tmpdir(), "signal-owner-factories-"));
afterAll(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});
const fixtureSources = {
  "turbo/apps/api/src/signals/services/agent-run-context.signals.ts": `
    export interface AgentRunContextSignals {
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly member$: Computed<Promise<unknown>>;
    }
  `,
  "bootstrap-identity.ts": `
    import type { AgentRunContextSignals as Bootstrap } from "./turbo/apps/api/src/signals/services/agent-run-context.signals";
    import { computed } from "ccstate";
    import { createLeaf } from "./leaf";
    export function createRead(bootstrap: Bootstrap) {
      const orgId = bootstrap.orgId;
      const first$ = createLeaf(bootstrap.userId);
      const second$ = computed(() => orgId + bootstrap.agentId);
      return { first$, second$ };
    }
  `,
  "bootstrap-signal-getter.ts": `
    import type { AgentRunContextSignals } from "./turbo/apps/api/src/signals/services/agent-run-context.signals";
    import { createLeaf } from "./leaf";
    export function createRead(bootstrap: AgentRunContextSignals) {
      return createLeaf(bootstrap.member$);
    }
  `,
  "bootstrap-unknown-field.ts": `
    import type { AgentRunContextSignals } from "./turbo/apps/api/src/signals/services/agent-run-context.signals";
    import { createLeaf } from "./leaf";
    export function createRead(bootstrap: AgentRunContextSignals) {
      return createLeaf(bootstrap.unknown);
    }
  `,
  "bootstrap-spoof-type.ts": `
    import type { AgentRunContextSignals } from "./spoof-bootstrap";
    import { createLeaf } from "./leaf";
    export function createRead(bootstrap: AgentRunContextSignals) {
      return createLeaf(bootstrap.orgId);
    }
  `,
  "spoof-bootstrap.ts": `
    export interface AgentRunContextSignals {
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
    }
  `,
  "fake/turbo/apps/api/src/signals/services/agent-run-context.signals.ts": `
    export interface AgentRunContextSignals {
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
    }
  `,
  "bootstrap-spoof-path.ts": `
    import type { AgentRunContextSignals } from "./fake/turbo/apps/api/src/signals/services/agent-run-context.signals";
    import { createLeaf } from "./leaf";
    export function createRead(bootstrap: AgentRunContextSignals) {
      return createLeaf(bootstrap.orgId);
    }
  `,
  "readonly-parameter.ts": `
    import { createLeaf } from "./leaf";
    export function createRead(input: { readonly source$: Computed<number> }) {
      return createLeaf(input.source$);
    }
  `,
  "leaf.ts": `
    import { computed as read } from "ccstate";
    export function createLeaf(input$) {
      const result$ = read(get => get(input$));
      return result$;
    }
  `,
  "nested.ts": `
    import { createLeaf as leaf } from "./leaf";
    import { computed } from "ccstate";
    function local(input$) {
      return computed(get => get(input$));
    }
    export function createRead(input$) {
      const first$ = leaf(input$);
      const second$ = local(first$);
      return second$;
    }
  `,
  "eager.ts": `
    import { computed } from "ccstate";
    export function createRead(input$) {
      const eager = readDatabase();
      return computed(get => get(input$) + eager);
    }
  `,
  "mutation.ts": `
    import { computed } from "ccstate";
    export function createRead(input$) {
      writeToDatabase();
      return computed(get => get(input$));
    }
  `,
  "default.ts": `
    import { computed } from "ccstate";
    export function createRead(input$ = readDatabase()) {
      return computed(get => get(input$));
    }
  `,
  "spoof.ts": `
    import { computed } from "other-package";
    export function createRead(input$) {
      return computed(get => get(input$));
    }
  `,
  "shadow.ts": `
    import { computed } from "ccstate";
    export function createRead(computed) {
      return computed(() => 1);
    }
  `,
  "command.ts": `
    import { command } from "ccstate";
    export function createRead(input$) {
      return command(({ get }) => get(input$));
    }
  `,
  "state.ts": `
    import { state } from "ccstate";
    export function createRead(input$) {
      return state(input$);
    }
  `,
  "reassigned.ts": `
    import { computed } from "ccstate";
    export function createRead(input$) {
      return computed(get => get(input$));
    }
    createRead = () => writeToDatabase();
  `,
  "reassigned-helper.ts": `
    import { computed } from "ccstate";
    function leaf(input$) {
      return computed(get => get(input$));
    }
    export function createRead(input$) {
      return leaf(input$);
    }
    [leaf] = [() => writeToDatabase()];
  `,
  "cycle.ts": `
    export function createRead(input$) {
      return createRead(input$);
    }
  `,
  "record.ts": `
    import { createLeaf as leaf } from "./leaf";
    import { computed } from "ccstate";
    export function createRead(inputs) {
      const first$ = leaf(inputs.source$);
      const channels = { first: first$, second: leaf(inputs.second$) };
      return computed(get => get(channels.first) + get(channels.second));
    }
  `,
  "forward-record.ts": `
    import { createRead as read } from "./record";
    function local(inputs) {
      return read(inputs);
    }
    export function createRead(inputs) {
      return local(inputs);
    }
  `,
  "bundle.ts": `
    import { createLeaf } from "./leaf";
    import { computed } from "ccstate";
    export function createRead(input$) {
      const first$ = computed(get => get(input$));
      const second$ = createLeaf(first$);
      return { first$, second$ };
    }
  `,
  "bundle-record.ts": `
    import { computed } from "ccstate";
    export function createRead(input$) {
      const first$ = computed(get => get(input$));
      const reads = { first$, second$: computed(get => get(first$)) };
      return reads;
    }
  `,
  "bundle-forward.ts": `
    import { createRead as createBundle } from "./bundle";
    import { createLeaf } from "./leaf";
    export function createRead(input$) {
      const bundle = createBundle(input$);
      const first$ = bundle.first$;
      const second$ = createLeaf(bundle.second$);
      return { first$, second$ };
    }
  `,
  "bundle-local.ts": `
    import { computed } from "ccstate";
    function createBundle(input$) {
      return { first$: computed(get => get(input$)) };
    }
    export function createRead(input$) {
      const bundle = createBundle(input$);
      return { first$: bundle.first$ };
    }
  `,
  "bundle-consumer.ts": `
    import { createLeaf } from "./leaf";
    export function createRead(inputs) {
      const { first$: source$ } = inputs;
      return createLeaf(source$);
    }
  `,
  ...Object.fromEntries(
    [
      ["default", "{ first$ = readDatabase() }"],
      ["rest", "{ first$, ...others }"],
      ["nested", "{ first$: { value } }"],
      ["key", "{ [readDatabase()]: first$ }"],
      ["missing", "{ missing$ }"],
    ].map(([name, binding]) => [
      `bundle-destructure-${name}.ts`,
      `
        import { computed } from "ccstate";
        export function createRead(inputs) {
          const ${binding} = inputs;
          return computed(() => 1);
        }
      `,
    ]),
  ),
  "bundle-destructure-shadow.ts": `
    import { computed } from "ccstate";
    export function createRead(inputs) {
      const { first$: computed } = inputs;
      return computed(() => 1);
    }
  `,
  ...Object.fromEntries(
    [
      ["getter", "{ get first$() { return readDatabase(); } }"],
      ["method", "{ first$() { return readDatabase(); } }"],
      ["spread", "{ ...input$ }"],
      ["prototype", "{ __proto__: input$, first$ }"],
      ["computed-key", "{ [readDatabase()]: first$ }"],
      ["eager", "{ first$: readDatabase() }"],
      ["command", "{ first$: command(() => 1) }"],
      ["state", "{ first$: state(1) }"],
      ["opaque-field", "{ first$: input$.first$ }"],
      ["opaque-node", "{ first$: input$ }"],
      ["literal", "{ first$: 1 }"],
      ["nested", "{ reads: { first$ } }"],
    ].map(([name, returned]) => [
      `bundle-${name}.ts`,
      `
        import { computed, command, state } from "ccstate";
        export function createRead(input$) {
          const first$ = computed(get => get(input$));
          return ${returned};
        }
      `,
    ]),
  ),
  "bundle-mutated.ts": `
    import { computed, state } from "ccstate";
    export function createRead(input$) {
      const first$ = computed(get => get(input$));
      const bundle = { first$ };
      const mutate$ = computed(() => { bundle.first$ = state(0); });
      return bundle;
    }
  `,
  "bundle-unknown-field.ts": `
    import { createRead as createBundle } from "./bundle";
    export function createRead(input$) {
      const bundle = createBundle(input$);
      return { first$: bundle.unknown$ };
    }
  `,
  ...Object.fromEntries(
    [
      ["getter", "{ get first() { return readDatabase(); } }"],
      ["method", "{ first() { return readDatabase(); } }"],
      ["spread", "{ ...inputs }"],
      ["computed-key", "{ [readDatabase()]: inputs.source$ }"],
      ["prototype", "{ __proto__: inputs }"],
      ["eager", "{ first: readDatabase() }"],
      ["command", "{ first: command(() => 1) }"],
      ["state", "{ first: state(1) }"],
      ["nested-read", "{ first: inputs.source$.value }"],
    ].map(([name, initializer]) => [
      `record-map-${name}.ts`,
      `
        import { computed, command, state } from "ccstate";
        export function createRead(inputs) {
          const channels = ${initializer};
          return computed(() => channels);
        }
      `,
    ]),
  ),
  ...Object.fromEntries(
    [
      ["default", "inputs = readDatabase()"],
      ["destructured", "{ source$ }"],
      ["rest", "...inputs"],
    ].map(([name, parameter]) => [
      `record-parameter-${name}.ts`,
      `
        import { computed } from "ccstate";
        export function createRead(${parameter}) {
          return computed(() => 1);
        }
      `,
    ]),
  ),
  "record-mutation.ts": `
    import { createLeaf as leaf } from "./leaf";
    import { computed } from "ccstate";
    export function createRead(inputs) {
      const result$ = leaf(inputs.source$);
      return computed(() => { delete inputs.source$; return result$; });
    }
  `,
};
for (const [name, source] of Object.entries(fixtureSources)) {
  const path = join(fixtureDirectory, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function ownerCallingFactory(module: string, argument = "source$") {
  return `
    import { computed } from "ccstate";
    import { createRead as build } from "./${module}";
    function createClaimRunObjects() {
      const source$ = computed(() => 1);
      const result$ = build(${argument});
      const wrapped$ = computed(get => get(result$));
      return { wrapped$ };
    }
  `;
}

ruleTester.run(
  "max-signal-owner-lines imported computed factories",
  maxSignalOwnerLines,
  {
    valid: [
      {
        name: "verifies imported aliases and nested local and imported read factories",
        options,
        filename: join(fixtureDirectory, "owner.ts"),
        code: ownerCallingFactory("nested"),
      },
      ...["bundle", "bundle-record", "bundle-forward", "bundle-local"].map(
        (module) => ({
          name: `verifies computed-only output records through ${module}`,
          options,
          filename: join(fixtureDirectory, "owner.ts"),
          code: ownerCallingFactory(module),
        }),
      ),
      {
        name: "allows only identity strings from the canonical bootstrap contract",
        options,
        filename: join(
          fixtureDirectory,
          "turbo/apps/api/src/signals/services/owner.ts",
        ),
        code: ownerCallingFactory("../../../../../../bootstrap-identity"),
      },
    ],
    invalid: [
      {
        name: "rejects a duplicate bootstrap path outside the owner's API tree",
        options,
        filename: join(
          fixtureDirectory,
          "turbo/apps/api/src/signals/services/owner.ts",
        ),
        code: ownerCallingFactory("../../../../../../bootstrap-spoof-path"),
        errors: [{ messageId: "tooLong" }],
      },
      ...[
        "eager",
        "mutation",
        "default",
        "spoof",
        "shadow",
        "command",
        "state",
        "cycle",
        "reassigned",
        "reassigned-helper",
        "missing",
        "bundle-getter",
        "bundle-method",
        "bundle-spread",
        "bundle-prototype",
        "bundle-computed-key",
        "bundle-eager",
        "bundle-command",
        "bundle-state",
        "bundle-opaque-field",
        "bundle-opaque-node",
        "bundle-literal",
        "bundle-nested",
        "bundle-mutated",
        "bundle-unknown-field",
        "bootstrap-signal-getter",
        "bootstrap-unknown-field",
        "bootstrap-spoof-type",
        "readonly-parameter",
      ].map((module) => ({
        name: `rejects unverified ${module} factory construction`,
        options,
        filename: join(fixtureDirectory, "owner.ts"),
        code: ownerCallingFactory(module),
        errors: [{ messageId: "tooLong" as const }],
      })),
      {
        name: "rejects eager work passed to a verified factory",
        options,
        filename: join(fixtureDirectory, "owner.ts"),
        code: ownerCallingFactory("nested", "readDatabase()"),
        errors: [{ messageId: "tooLong" }],
      },
    ],
  },
);

function ownerForwardingBundle(module = "bundle-consumer", extra = "") {
  return `
    import { computed } from "ccstate";
    import { createRead as build } from "./bundle";
    import { createRead as consume } from "./${module}";
    function createClaimRunObjects() {
      const source$ = computed(() => 1);
      const inputs = build(source$);
      const first$ = inputs.first$;
      const second$ = computed(get => get(inputs.second$));
      const result$ = consume(inputs);
      ${extra}
      return { first$, second$, result$ };
    }
  `;
}

ruleTester.run(
  "max-signal-owner-lines forwards verified computed bundles",
  maxSignalOwnerLines,
  {
    valid: [
      {
        name: "tracks constructed bundle fields through safe reads and destructuring",
        options,
        filename: join(fixtureDirectory, "owner.ts"),
        code: ownerForwardingBundle(),
      },
    ],
    invalid: [
      ...["default", "rest", "nested", "key", "missing", "shadow"].map(
        (name) => ({
          name: `rejects unsafe bundle destructuring: ${name}`,
          options,
          filename: join(fixtureDirectory, "owner.ts"),
          code: ownerForwardingBundle(`bundle-destructure-${name}`),
          errors: [{ messageId: "tooLong" as const }],
        }),
      ),
      ...[
        "const alias = inputs;",
        "const mutation$ = computed(() => { inputs.first$ = source$; });",
        "const mutation$ = computed(() => { delete inputs.first$; });",
        "const mutation$ = computed(() => { ({ first: inputs.first$ } = replacement); });",
        "const mutation$ = computed(() => { for (inputs.first$ of replacements) {} });",
        "const mutation$ = computed(() => Object.defineProperty(inputs, 'first$', { get: readDatabase }));",
      ].map((extra) => ({
        name: `rejects escaped or mutated bundles: ${extra}`,
        options,
        filename: join(fixtureDirectory, "owner.ts"),
        code: ownerForwardingBundle("bundle-consumer", extra),
        errors: [{ messageId: "tooLong" as const }],
      })),
    ],
  },
);

function ownerCallingRecordFactory(
  module = "record",
  initializer = "{ source$, second$: source$ }",
  extra = "",
) {
  return `
    import { computed } from "ccstate";
    import { createRead as build } from "./${module}";
    function createClaimRunObjects(unknownInput) {
      const source$ = computed(() => 1);
      const inputs = ${initializer};
      const result$ = build(inputs);
      ${extra}
      return { result$ };
    }
  `;
}

ruleTester.run(
  "max-signal-owner-lines computed factories with flat input records",
  maxSignalOwnerLines,
  {
    valid: [
      ...["record", "forward-record"].map((module) => ({
        name: `verifies own data fields and computed maps through ${module}`,
        options,
        filename: join(fixtureDirectory, "owner.ts"),
        code: ownerCallingRecordFactory(module),
      })),
      {
        name: "derives fields from the actual literal underneath a type assertion",
        options,
        filename: join(fixtureDirectory, "owner.ts"),
        code: ownerCallingRecordFactory(
          "record",
          "{ source$, second$: source$ } as Inputs",
        ),
      },
    ],
    invalid: [
      ...[
        "{ get source$() { return readDatabase(); }, second$: source$ }",
        "{ source$() { return readDatabase(); }, second$: source$ }",
        "{ ...unknownInput, second$: source$ }",
        "{ [readDatabase()]: source$, second$: source$ }",
        "{ __proto__: unknownInput, source$, second$: source$ }",
        "{ source$: readDatabase(), second$: source$ }",
        "{ second$: source$ } as Inputs",
        "unknownInput as Inputs",
      ].map((initializer) => ({
        name: `rejects unproven owner record ${initializer}`,
        options,
        filename: join(fixtureDirectory, "owner.ts"),
        code: ownerCallingRecordFactory("record", initializer),
        errors: [{ messageId: "tooLong" as const }],
      })),
      ...[
        "const alias = inputs;",
        "inputs.source$ = source$;",
        "const mutation$ = computed(() => Object.defineProperty(inputs, 'source$', { get: readDatabase }));",
        // Verifying the same factory with a record must not authorize opaque inputs.
        "const unsafe$ = build(unknownInput);",
      ].map((extra) => ({
        name: `rejects escaped records or unsafe subsequent invocation: ${extra}`,
        options,
        filename: join(fixtureDirectory, "owner.ts"),
        code: ownerCallingRecordFactory(
          "record",
          "{ source$, second$: source$ }",
          extra,
        ),
        errors: [{ messageId: "tooLong" as const }],
      })),
      ...Object.keys(fixtureSources)
        .filter((name) => {
          return (
            name.startsWith("record-map-") ||
            name.startsWith("record-parameter-") ||
            name === "record-mutation.ts"
          );
        })
        .map((module) => ({
          name: `rejects unverified construction in ${module}`,
          options,
          filename: join(fixtureDirectory, "owner.ts"),
          code: ownerCallingRecordFactory(module),
          errors: [{ messageId: "tooLong" as const }],
        })),
    ],
  },
);
