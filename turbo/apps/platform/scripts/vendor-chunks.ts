import type { Plugin } from "vite";

import { isVendorModule } from "./single-bundle.ts";
import manifest from "./vendor-groups.json";

export const VENDOR_GROUP_IDS = [1, 2, 3, 4, 5] as const;

function vendorPackageName(moduleId: string): string | undefined {
  const normalized = moduleId.replaceAll("\\", "/");
  if (!isVendorModule(normalized)) {
    return undefined;
  }
  if (normalized.endsWith("/packages/mermaid-lite/dist/mermaid.esm.min.mjs")) {
    return "@okouai/mermaid-lite";
  }
  // Use the last node_modules segment to handle pnpm paths and scoped names.
  const packagePath = normalized.slice(
    normalized.lastIndexOf("/node_modules/") + "/node_modules/".length,
  );
  const segments = packagePath.split("/");
  return packagePath.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

export function dependencyVendorChunks(
  packageGroups: Readonly<Record<string, number>> = manifest.packages,
) {
  const assignments = new Map(Object.entries(packageGroups));
  for (const [name, group] of assignments) {
    if (
      !Number.isInteger(group) ||
      group < 1 ||
      group > VENDOR_GROUP_IDS.length
    ) {
      throw new Error(`Invalid vendor group for ${name}: ${group}`);
    }
  }

  function groupFor(moduleId: string): number | undefined {
    const name = vendorPackageName(moduleId);
    if (name === undefined) {
      return undefined;
    }
    const group = assignments.get(name);
    if (group === undefined) {
      throw new Error(
        `Unassigned vendor package: ${name}. Regenerate vendor-groups.json with the dependency partitioner.`,
      );
    }
    return group;
  }

  const plugin: Plugin = {
    name: "platform-dependency-vendor-chunks",
    apply: "build",
    buildEnd(error) {
      if (error) {
        return;
      }
      // Inspect the resolved graph, including barrel re-exports. A dependency
      // may stay within a group or point to a lower-numbered group only.
      for (const id of this.getModuleIds()) {
        const sourceGroup = groupFor(id);
        if (sourceGroup === undefined) {
          continue;
        }
        const info = this.getModuleInfo(id);
        if (!info) {
          this.error(`Missing module information: ${id}`);
        }
        for (const dependencyId of [
          ...info.importedIds,
          ...info.dynamicallyImportedIds,
        ]) {
          const dependencyGroup = groupFor(dependencyId);
          if (dependencyGroup !== undefined && dependencyGroup > sourceGroup) {
            this.error(
              `Vendor dependency reverses layers: ${vendorPackageName(id)} (${sourceGroup}) -> ${vendorPackageName(dependencyId)} (${dependencyGroup}). Regenerate vendor-groups.json.`,
            );
          }
        }
      }
    },
    generateBundle(_options, bundle) {
      const vendorChunks = Object.values(bundle).filter((output) => {
        return output.type === "chunk" && output.name.startsWith("vendor-");
      });
      const groupByFile = new Map<string, number>();
      for (const group of VENDOR_GROUP_IDS) {
        const matches = vendorChunks.filter((chunk) => {
          return chunk.type === "chunk" && chunk.name === `vendor-${group}`;
        });
        const chunk = matches[0];
        if (matches.length !== 1 || chunk?.type !== "chunk") {
          this.error(`Expected exactly one vendor-${group} chunk`);
        }
        groupByFile.set(chunk.fileName, group);
      }
      if (vendorChunks.length !== VENDOR_GROUP_IDS.length) {
        this.error("Expected exactly five numbered vendor chunks");
      }
      const moduleOwners = new Set<string>();
      for (const chunk of vendorChunks) {
        if (chunk.type !== "chunk") {
          continue;
        }
        const group = groupByFile.get(chunk.fileName);
        if (group === undefined) {
          this.error(`Unrecognized vendor chunk: ${chunk.fileName}`);
        }
        for (const id of chunk.moduleIds) {
          if (moduleOwners.has(id)) {
            this.error(`Module duplicated across vendor chunks: ${id}`);
          }
          moduleOwners.add(id);
          if (groupFor(id) !== group) {
            this.error(`Module escaped its assigned vendor group: ${id}`);
          }
        }
        for (const importedFile of [
          ...chunk.imports,
          ...chunk.dynamicImports,
        ]) {
          if (/^assets\/rolldown-runtime-[^/]+\.js$/u.test(importedFile)) {
            continue;
          }
          const dependencyGroup = groupByFile.get(importedFile);
          if (dependencyGroup === undefined || dependencyGroup >= group) {
            this.error(
              `Invalid emitted vendor dependency: ${chunk.fileName} -> ${importedFile}`,
            );
          }
        }
      }
    },
  };

  return {
    plugin,
    groups: VENDOR_GROUP_IDS.map((group) => {
      return {
        name: `vendor-${group}`,
        test(moduleId: string) {
          return groupFor(moduleId) === group;
        },
      };
    }),
  };
}
