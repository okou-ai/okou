import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import rule from "../rules/no-create-store.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-create-store", rule, {
  valid: [
    {
      code: `
        import { command, state, type Store } from "ccstate";

        const count$ = state(0);
        const increment$ = command(({ get, set }) => set(count$, get(count$) + 1));
        export { increment$ };
      `,
    },
    {
      code: `
        import * as ccstate from "ccstate";

        const count$ = ccstate.state(0);
        const increment$ = ccstate["command"](({ get, set }) => set(count$, get(count$) + 1));
      `,
    },
    {
      code: `
        import { createStore } from "another-package";
        import * as another from "another-package";

        createStore();
        another.createStore();
      `,
    },
    {
      code: `
        function createStore() {
          return {};
        }

        createStore();
      `,
    },
    {
      code: `
        const storage = { createStore: () => ({}) };

        storage.createStore();
      `,
    },
    {
      code: `
        import { createStore } from "ccstate";

        function run(createStore: () => unknown) {
          return createStore();
        }
      `,
    },
    {
      code: `
        import * as ccstate from "ccstate";

        function run(ccstate: { createStore(): unknown }) {
          return ccstate.createStore();
        }
      `,
    },
    {
      code: `
        import type { createStore, Store } from "ccstate";
        import type * as ccstate from "ccstate";

        type Factory = typeof createStore;
        type Namespace = typeof ccstate;
      `,
    },
    {
      code: `
        import { createStore } from "ccstate";
        import * as ccstate from "ccstate";

        type Factory = typeof createStore;
        type Namespace = typeof ccstate;
        type NamespaceFactory = typeof ccstate.createStore;
        type Store = import("ccstate").Store;
      `,
    },
    {
      code: `
        export type { createStore, Store } from "ccstate";
        export { type createStore as Factory } from "ccstate";
        export type * from "ccstate";
      `,
    },
    {
      code: `
        import { createStore } from "ccstate";

        export type { createStore };
      `,
    },
    {
      code: `
        export { command, state } from "ccstate";
        export { createStore } from "another-package";
        export * from "another-package";
      `,
    },
    {
      code: `
        const dynamicModule = await import("another-package");
        const requiredModule = require("another-package");
      `,
    },
    {
      code: `
        function load(require: (name: string) => unknown) {
          return require("ccstate");
        }
      `,
    },
    {
      name: "allows a documented local suppression at the factory reference",
      code: `
        import { createStore } from "ccstate";

        // eslint-disable-next-line @rule-tester/no-create-store -- Existing store ownership awaits migration.
        const store = createStore();
      `,
    },
  ],
  invalid: [
    {
      name: "reports a module-level store",
      code: `
        import { createStore } from "ccstate";

        const store = createStore();
      `,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      name: "reports a store created inside a business helper",
      code: `
        import { createStore } from "ccstate";

        function loadBinding() {
          const store = createStore();
          return store.get(binding$);
        }
      `,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      code: `
        import { createStore as createRequestStore } from "ccstate";

        const store = createRequestStore();
      `,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      name: "reports the source reference when a factory is assigned to an alias",
      code: `
        import { createStore } from "ccstate";

        const factory = createStore;
        const store = factory();
      `,
      errors: [{ messageId: "noCreateStore", line: 4 }],
    },
    {
      name: "reports a factory passed as a callback",
      code: `
        import { createStore } from "ccstate";

        registerFactory(createStore);
      `,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      code: `
        import { createStore } from "ccstate";

        const factory = createStore.bind(undefined);
      `,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      code: `
        import { createStore } from "ccstate";

        export { createStore as createRequestStore };
      `,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      code: `
        import * as ccstate from "ccstate";

        const store = ccstate.createStore();
      `,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      code: `
        import * as ccstate from "ccstate";

        const store = ccstate["createStore"]();
      `,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      name: "reports the source namespace when it is assigned to an alias",
      code: `
        import * as ccstate from "ccstate";

        const factories = ccstate;
        const store = factories.createStore();
      `,
      errors: [{ messageId: "noCreateStore", line: 4 }],
    },
    {
      code: `
        import * as ccstate from "ccstate";

        registerFactories(ccstate);
      `,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      code: `
        import * as ccstate from "ccstate";

        const { createStore } = ccstate;
        const store = createStore();
      `,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      code: `export { createStore } from "ccstate";`,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      code: `export { createStore as createRequestStore } from "ccstate";`,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      code: `export * from "ccstate";`,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      code: `export * as ccstate from "ccstate";`,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      code: `const ccstate = await import("ccstate");`,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      code: `const ccstate = require("ccstate");`,
      errors: [{ messageId: "noCreateStore" }],
    },
    {
      name: "reports every unsuppressed factory reference",
      code: `
        import { createStore } from "ccstate";

        const first = createStore();
        const second = createStore();
      `,
      errors: [
        { messageId: "noCreateStore", line: 4 },
        { messageId: "noCreateStore", line: 5 },
      ],
    },
    {
      name: "a local suppression does not hide the next store creation",
      code: `
        import { createStore } from "ccstate";

        // eslint-disable-next-line @rule-tester/no-create-store -- Existing store ownership awaits migration.
        const first = createStore();
        const second = createStore();
      `,
      errors: [{ messageId: "noCreateStore", line: 6 }],
    },
  ],
});
