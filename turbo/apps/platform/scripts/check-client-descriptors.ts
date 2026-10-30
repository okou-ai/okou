import type { Plugin } from "vite";

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
 * Only the full agents route module is forbidden: other routes may legitimately
 * use the shared agents validators and Zod. The generated descriptor itself is
 * literal metadata with type-only references, so it has no runtime imports.
 * Worker builds share the exclusion without requiring an unused descriptor.
 */
export function clientDescriptorsPlugin({
  requireAgentsDescriptor = true,
}: { requireAgentsDescriptor?: boolean } = {}): Plugin {
  return {
    apply: "build",
    enforce: "post",
    name: "platform-client-descriptors",
    generateBundle(_options, bundle) {
      const descriptors = new Set<string>();
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
          if (modulePath === "contracts/agents.ts") {
            this.error(
              `${output.fileName}: full agents contract reached the production bundle: ${moduleId}. Import the schema-free client descriptor instead.`,
            );
          }
          if (modulePath === "client/agents.ts") {
            descriptors.add(moduleId);
          }
        }
      }
      if (chunkCount === 0) {
        this.error(
          "Client descriptor guard requires emitted JavaScript chunks",
        );
      }
      if (requireAgentsDescriptor && descriptors.size === 0) {
        this.error(
          "Generated agents client descriptor is missing from the production bundle graph",
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
