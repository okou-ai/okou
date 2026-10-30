import type { Plugin } from "vite";

import { clientDescriptorManifest } from "../../../packages/api-contracts/src/client/manifest.ts";

const API_CONTRACTS_SOURCE =
  /\/(?:packages\/api-contracts|node_modules\/@okouai\/api-contracts)\/src\//u;

function apiContractsModulePath(moduleId: string): string | undefined {
  const [filePath = ""] = moduleId.replaceAll("\\", "/").split(/[?#]/u);
  const packageSource = API_CONTRACTS_SOURCE.exec(filePath);
  return packageSource
    ? filePath.slice(packageSource.index + packageSource[0].length)
    : undefined;
}

/**
 * Check emitted production chunks, not source text or minified schema names.
 *
 * Full HTTP contract modules are forbidden; independent validators and Zod
 * remain valid runtime dependencies. Each generated descriptor contains literal
 * metadata with type-only references and therefore has no runtime imports.
 * Worker builds share the exclusion without requiring unused descriptors.
 */
export function clientDescriptorsPlugin({
  requireDescriptor = true,
}: { requireDescriptor?: boolean } = {}): Plugin {
  const contractModules = new Set<string>(
    clientDescriptorManifest.map(({ module }) => {
      return module;
    }),
  );
  return {
    apply: "build",
    enforce: "post",
    name: "platform-client-descriptors",
    generateBundle(_options, bundle) {
      const descriptors = new Set<string>();
      const fullContracts = new Set<string>();
      let chunkCount = 0;
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") {
          continue;
        }
        chunkCount += 1;
        if (!Array.isArray(output.moduleIds)) {
          this.error(
            `${output.fileName}: client descriptor guard requires emitted chunk module IDs`,
          );
        }
        for (const moduleId of output.moduleIds) {
          const modulePath = apiContractsModulePath(moduleId);
          const contract = /^contracts\/(.+)\.ts$/u.exec(modulePath ?? "");
          if (contract && contractModules.has(contract[1])) {
            fullContracts.add(moduleId);
          }
          const descriptor = /^client\/(.+)\.ts$/u.exec(modulePath ?? "");
          if (descriptor && contractModules.has(descriptor[1])) {
            descriptors.add(moduleId);
          }
        }
      }
      if (fullContracts.size > 0) {
        this.error(
          `Full HTTP contract reached the production bundle:\n${[...fullContracts].sort().join("\n")}\nImport schema-free client descriptors or independent validators instead.`,
        );
      }
      if (chunkCount === 0) {
        this.error(
          "Client descriptor guard requires emitted JavaScript chunks",
        );
      }
      if (requireDescriptor && descriptors.size === 0) {
        this.error(
          "Generated client descriptor is missing from the production bundle graph",
        );
      }
      for (const descriptorId of descriptors) {
        const info = this.getModuleInfo(descriptorId);
        if (
          !info ||
          !Array.isArray(info.importedIds) ||
          !Array.isArray(info.dynamicallyImportedIds)
        ) {
          this.error(
            `Client descriptor guard requires resolved module information: ${descriptorId}`,
          );
        }
        const dependencies = [
          ...info.importedIds,
          ...info.dynamicallyImportedIds,
        ];
        if (dependencies.length > 0) {
          this.error(
            `${descriptorId}: generated client descriptors must have no runtime imports (including schemas): ${dependencies.join(", ")}. Use type-only imports for contract and client types.`,
          );
        }
      }
    },
  };
}
