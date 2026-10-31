import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { build } from "esbuild";
import { workerBuildOptions } from "./worker-build-options.mjs";

const apiRoot = resolve(import.meta.dirname, "..");
const contractPattern = /packages\/api-contracts\/src\/contracts\/(.+)\.ts$/;

// Importing a contract module constructs every schema it declares and every
// schema its static imports declare: esbuild cannot drop unused top-level Zod
// constants. Each route group below must not pull the listed contract modules
// into its Worker graph; import the per-endpoint module instead.
const boundaries = [
  {
    name: "chat send",
    routes: ["src/signals/routes/chat-events.ts"],
    forbiddenContracts: ["chat-threads", "chat-remote-access", "cron", "host"],
  },
  {
    name: "data",
    routes: [
      "src/signals/routes/cron-cleanup-x-resource-reads.ts",
      "src/signals/routes/data-router-history.ts",
      "src/signals/routes/webhooks-agent-data-request.ts",
    ],
    forbiddenContracts: [
      "chat-threads",
      "connector-catalog-sync",
      "cron",
      "official-workflow-catalog",
      "workflows",
    ],
  },
];

function importChain(metafile, entryInputs, target) {
  const previous = new Map(
    entryInputs.map((input) => {
      return [input, null];
    }),
  );
  const queue = [...entryInputs];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === target) {
      const chain = [];
      for (let node = current; node !== null; node = previous.get(node)) {
        chain.unshift(node);
      }
      return chain;
    }
    for (const dependency of metafile.inputs[current]?.imports ?? []) {
      if (!previous.has(dependency.path)) {
        previous.set(dependency.path, current);
        queue.push(dependency.path);
      }
    }
  }
  return [target];
}

for (const boundary of boundaries) {
  test(`${boundary.name} routes do not construct unrelated contract modules`, async () => {
    const { metafile } = await build({
      ...workerBuildOptions(apiRoot),
      absWorkingDir: apiRoot,
      stdin: {
        contents: boundary.routes
          .map((route) => {
            return `export * from ${JSON.stringify(`./${route}`)};`;
          })
          .join("\n"),
        resolveDir: apiRoot,
        loader: "ts",
      },
      metafile: true,
      write: false,
      logLevel: "silent",
    });
    const entryInputs = Object.keys(metafile.inputs).filter((input) => {
      return boundary.routes.some((route) => {
        return input.endsWith(route);
      });
    });
    assert.equal(entryInputs.length, boundary.routes.length);

    const violations = Object.keys(metafile.inputs).flatMap((input) => {
      const contract = contractPattern.exec(input)?.[1];
      if (
        contract === undefined ||
        !boundary.forbiddenContracts.includes(contract)
      ) {
        return [];
      }
      return [importChain(metafile, entryInputs, input).join("\n  -> ")];
    });
    assert.deepEqual(violations, []);
  });
}
