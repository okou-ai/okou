import path from "node:path";

export interface ClientContractImportBinding {
  readonly name: string;
  readonly source: string;
  readonly imported: string;
}

export interface ClientContractImportModule {
  readonly module: string;
  readonly contracts: readonly string[];
  readonly bindings: readonly ClientContractImportBinding[];
}

export interface ClientContractImportOptions {
  readonly modules: readonly ClientContractImportModule[];
  readonly contractsDirectory: string;
}

export interface ContractSource {
  readonly module: ClientContractImportModule | null;
  readonly source: string;
  readonly packageImport: boolean;
}

const packageName = "@okouai/api-contracts";

function withoutExtension(value: string): string {
  return value.replace(/\.(?:ts|js)$/u, "");
}

/** Resolve only paths and supplied metadata; never inspect the filesystem. */
export function contractPaths(
  options: ClientContractImportOptions,
  filename: string,
) {
  const contractsDirectory = path.resolve(options.contractsDirectory);
  const apiClientSignalSource = withoutExtension(
    path.resolve(
      contractsDirectory,
      "../../../../apps/platform/src/signals/api-client.ts",
    ),
  );
  const packageBarrels = new Set([
    packageName,
    `${packageName}/index`,
    `${packageName}/contracts`,
    `${packageName}/contracts/index`,
    "@okouai/core",
    "@okouai/core/index",
    "@okouai/core/contracts",
    "@okouai/core/contracts/index",
  ]);
  const coreDirectory = path.resolve(contractsDirectory, "../../../core/src");
  const localBarrels = new Set([
    contractsDirectory,
    path.resolve(contractsDirectory, "index"),
    path.resolve(contractsDirectory, ".."),
    path.resolve(contractsDirectory, "../index"),
    coreDirectory,
    path.resolve(coreDirectory, "index"),
    path.resolve(coreDirectory, "contracts"),
    path.resolve(coreDirectory, "contracts/index"),
  ]);
  const modules = new Map<string, ClientContractImportModule | null>();
  for (const item of options.modules) {
    // Conflicting module metadata must not produce a guessed migration.
    modules.set(item.module, modules.has(item.module) ? null : item);
  }

  function localPath(source: string): string | null {
    return source.startsWith(".") || path.isAbsolute(source)
      ? path.resolve(path.dirname(filename), source)
      : null;
  }

  function identify(source: string): ContractSource | null {
    let name: string;
    let packageImport: boolean;
    if (packageBarrels.has(withoutExtension(source))) {
      return { source, module: null, packageImport: true };
    }
    if (source.startsWith(`${packageName}/contracts/`)) {
      name = withoutExtension(source.slice(`${packageName}/contracts/`.length));
      packageImport = true;
    } else {
      const resolved = localPath(source);
      if (resolved === null) {
        return null;
      }
      name = withoutExtension(path.relative(contractsDirectory, resolved));
      if (localBarrels.has(withoutExtension(resolved))) {
        return { source, module: null, packageImport: false };
      }
      packageImport = false;
    }
    const module = modules.get(name);
    return module === undefined ? null : { source, module, packageImport };
  }

  function destination(source: ContractSource, subpath: string): string {
    if (source.packageImport) {
      return `${packageName}/${subpath}`;
    }
    const extension = source.source.match(/\.(?:ts|js)$/u)?.[0] ?? "";
    const absolute = path.resolve(
      contractsDirectory,
      "..",
      `${subpath}${extension}`,
    );
    if (path.isAbsolute(source.source)) {
      return absolute;
    }
    const relative = path.relative(path.dirname(filename), absolute);
    return relative.startsWith(".") ? relative : `./${relative}`;
  }

  function independentSource(source: string): boolean {
    if (!/^(?:validators|contracts)\/[\w/-]+$/u.test(source)) {
      return false;
    }
    return (
      !source.startsWith("contracts/") ||
      (!modules.has(source.slice("contracts/".length)) &&
        source !== "contracts/index")
    );
  }

  function isTransport(source: string): boolean {
    if (withoutExtension(source) === `${packageName}/client/transport`) {
      return true;
    }
    const resolved = localPath(source);
    return (
      resolved !== null &&
      withoutExtension(resolved) ===
        path.resolve(contractsDirectory, "../client/transport")
    );
  }

  function isApiClientSignalSource(source: string): boolean {
    const resolved = localPath(source);
    return (
      resolved !== null && withoutExtension(resolved) === apiClientSignalSource
    );
  }

  return {
    identify,
    destination,
    independentSource,
    isTransport,
    isApiClientSignalSource,
  };
}
