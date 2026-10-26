import { WORKER_DOMAINS } from "./worker-domain-ownership.mjs";

// Inspect emitted modules, not source-only/type-only imports. These boundaries
// must hold for normal builds as well as isolated benchmark builds.
export function validateWorkerRouteBoundaries(metafile) {
  const retained = new Set();
  let domain;
  for (const output of Object.values(metafile.outputs)) {
    for (const [path, input] of Object.entries(output.inputs ?? {})) {
      if (input.bytesInOutput > 0) {
        retained.add(path);
      }
    }
    domain ??= WORKER_DOMAINS.find((name) => {
      return output.entryPoint === `src/worker-domains/${name}.ts`;
    });
  }
  if (!domain) {
    return;
  }
  for (const path of retained) {
    if (
      path === "src/signals/route.ts" ||
      WORKER_DOMAINS.some((other) => {
        return (
          other !== domain && path === `src/signals/route-groups/${other}.ts`
        );
      }) ||
      path.endsWith("api-contracts/src/client-transforms/desktop.ts")
    ) {
      throw new Error(
        `${domain} Worker retained a global or foreign registry: ${path}`,
      );
    }
    if (
      domain === "data" &&
      /api-contracts\/src\/(?:client-transforms\/computer-use-claim|contracts\/(?:computer-use|desktop-updates|browser-user-actions|workflows|official-workflow-catalog|cron|errors|run-balance-errors|model-providers|okou-model-metadata|okou-codex-model-messages))\.(?:ts|json)$/.test(
        path,
      )
    ) {
      throw new Error(
        `Data Worker retained an unrelated business contract: ${path}`,
      );
    }
  }
}
