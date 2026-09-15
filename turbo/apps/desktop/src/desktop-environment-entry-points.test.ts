import packageMetadata from "../package.json";
import identities from "./desktop-identities.json";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const desktopDirectory = resolve(__dirname, "..");
const turboDirectory = resolve(desktopDirectory, "../..");
const temporaryDirectories: string[] = [];

const environmentNames = {
  canonicalPlatformUrl: "OKOU_DESKTOP_PLATFORM_URL",
  canonicalProduct: "OKOU_DESKTOP_PRODUCT",
} as const;

const buildConfigHarnessSource = `
const { resolveDesktopBuildConfig } = require(process.env.TEST_CONFIG_MODULE);

function optionalValue(prefix) {
  return process.env[prefix + "_DEFINED"] === "true"
    ? process.env[prefix + "_VALUE"]
    : undefined;
}

const config = resolveDesktopBuildConfig({
  platformUrl: optionalValue("TEST_PLATFORM_ARGUMENT"),
  product: optionalValue("TEST_PRODUCT_ARGUMENT"),
});
if (
  config.product !== process.env.TEST_EXPECTED_PRODUCT ||
  config.platformUrl.toString() !== process.env.TEST_EXPECTED_PLATFORM_URL ||
  config.identity.displayName !== process.env.TEST_EXPECTED_DISPLAY_NAME
) {
  throw new Error("Desktop build configuration changed");
}
`;

const installedConfigHarnessSource = `
import { resolveDesktopConfig } from "./src/config.ts";

function optionalValue(prefix: string): string | undefined {
  return process.env[prefix + "_DEFINED"] === "true"
    ? process.env[prefix + "_VALUE"]
    : undefined;
}

const config = resolveDesktopConfig(
  optionalValue("TEST_PLATFORM_ARGUMENT"),
  optionalValue("TEST_PRODUCT_ARGUMENT"),
);
if (
  config.identity.product !== process.env.TEST_EXPECTED_PRODUCT ||
  config.platformUrl.toString() !== process.env.TEST_EXPECTED_PLATFORM_URL ||
  config.authUrl.origin !== (config.environment === "production" ? "https://app.okou.ai" : config.platformUrl.origin) ||
  config.authPartition === config.sessionPartition ||
  config.environment !== process.env.TEST_EXPECTED_ENVIRONMENT ||
  config.identity.displayName !== process.env.TEST_EXPECTED_DISPLAY_NAME ||
  config.sessionPartition !== process.env.TEST_EXPECTED_SESSION_PARTITION
) {
  throw new Error("Installed Desktop configuration changed");
}
`;

const forgeConfigHarnessSource = `
const path = require("node:path");
const config = require(process.env.TEST_FORGE_CONFIG);
if (
  path.basename(config.packagerConfig.icon) !==
  process.env.TEST_EXPECTED_APP_ICON_BASE_NAME
) {
  throw new Error("Desktop package icon changed");
}
`;

const platformOverrideSource = `
Object.defineProperty(process, "platform", { value: "darwin" });
`;

interface EnvironmentValues {
  readonly canonicalPlatformUrl?: string;
  readonly canonicalProduct?: string;
}

interface RuntimeFileConfig {
  readonly platformUrl: string;
  readonly product?: unknown;
}

interface SurfaceCase {
  readonly environment?: EnvironmentValues;
  readonly fileConfig?: RuntimeFileConfig;
  readonly platformArgument?: string;
  readonly productArgument?: string;
  readonly expectedProduct: "okou";
  readonly expectedPlatformUrl: string;
  readonly expectedDisplayName: string;
}

interface InstalledSurfaceCase extends SurfaceCase {
  readonly expectedEnvironment: "production" | "staging" | "development";
}

interface DesktopFixture {
  readonly desktopDirectory: string;
  readonly platformOverridePath: string;
  readonly tracePath: string;
}

interface EntryPointResult {
  readonly process: SpawnSyncReturns<string>;
  readonly trace: string;
}

function createDesktopFixture(): DesktopFixture {
  const directory = mkdtempSync(join(tmpdir(), "desktop-environment-entry-"));
  temporaryDirectories.push(directory);
  const fixtureDesktopDirectory = join(directory, "desktop");
  const scriptsDirectory = join(fixtureDesktopDirectory, "scripts");
  const sourceDirectory = join(fixtureDesktopDirectory, "src");
  mkdirSync(scriptsDirectory, { recursive: true });
  mkdirSync(sourceDirectory, { recursive: true });

  for (const relativePath of [
    "scripts/desktop-build-config.js",
    "scripts/desktop-environment.js",
    "scripts/packaged-app-paths.js",
    "scripts/run-packaged-app.js",
    "scripts/smoke-test-packaged-app.js",
    "scripts/desktop-smoke-evidence.js",
    "package.json",
    "src/config.ts",
    "src/desktop-api-base-url.ts",
    "src/desktop-identities.json",
  ]) {
    copyFileSync(
      join(desktopDirectory, relativePath),
      join(fixtureDesktopDirectory, relativePath),
    );
  }

  const platformOverridePath = join(directory, "darwin-platform.cjs");
  writeFileSync(platformOverridePath, platformOverrideSource);
  return {
    desktopDirectory: fixtureDesktopDirectory,
    platformOverridePath,
    tracePath: join(directory, "external-side-effects.txt"),
  };
}

function writeRuntimeConfig(
  fixture: DesktopFixture,
  config: RuntimeFileConfig | undefined,
): void {
  if (config) {
    writeFileSync(
      join(fixture.desktopDirectory, "desktop-runtime-config.json"),
      JSON.stringify(config),
    );
  }
}

function applyEnvironmentValues(
  environment: NodeJS.ProcessEnv,
  values: EnvironmentValues | undefined,
): void {
  if (!values) {
    return;
  }

  for (const [environmentName, value] of [
    [environmentNames.canonicalPlatformUrl, values.canonicalPlatformUrl],
    [environmentNames.canonicalProduct, values.canonicalProduct],
  ] as const) {
    if (value !== undefined) {
      environment[environmentName] = value;
    }
  }
}

function baseEnvironment(): NodeJS.ProcessEnv {
  return process.env.PATH ? { PATH: process.env.PATH } : {};
}

function surfaceEnvironment(
  testCase: SurfaceCase,
  fixture: DesktopFixture,
): NodeJS.ProcessEnv {
  const environment = baseEnvironment();
  environment.TEST_CONFIG_MODULE = join(
    fixture.desktopDirectory,
    "scripts",
    "desktop-build-config.js",
  );
  environment.TEST_EXPECTED_DISPLAY_NAME = testCase.expectedDisplayName;
  environment.TEST_EXPECTED_PLATFORM_URL = testCase.expectedPlatformUrl;
  environment.TEST_EXPECTED_PRODUCT = testCase.expectedProduct;
  environment.TEST_PLATFORM_ARGUMENT_DEFINED = String(
    testCase.platformArgument !== undefined,
  );
  environment.TEST_PLATFORM_ARGUMENT_VALUE = testCase.platformArgument;
  environment.TEST_PRODUCT_ARGUMENT_DEFINED = String(
    testCase.productArgument !== undefined,
  );
  environment.TEST_PRODUCT_ARGUMENT_VALUE = testCase.productArgument;
  applyEnvironmentValues(environment, testCase.environment);
  return environment;
}

function trace(fixture: DesktopFixture): string {
  return existsSync(fixture.tracePath)
    ? readFileSync(fixture.tracePath, "utf8")
    : "";
}

function runBuildConfig(testCase: SurfaceCase): EntryPointResult {
  const fixture = createDesktopFixture();
  writeRuntimeConfig(fixture, testCase.fileConfig);
  const processResult = spawnSync(
    process.execPath,
    ["--eval", buildConfigHarnessSource],
    { encoding: "utf8", env: surfaceEnvironment(testCase, fixture) },
  );
  return { process: processResult, trace: trace(fixture) };
}

function runInstalledConfig(testCase: InstalledSurfaceCase): EntryPointResult {
  const fixture = createDesktopFixture();
  writeRuntimeConfig(fixture, testCase.fileConfig);
  const harnessPath = join(fixture.desktopDirectory, "installed-config.ts");
  writeFileSync(harnessPath, installedConfigHarnessSource);
  const environment = surfaceEnvironment(testCase, fixture);
  environment.TEST_EXPECTED_ENVIRONMENT = testCase.expectedEnvironment;
  environment.TEST_EXPECTED_SESSION_PARTITION = `persist:vm0-desktop-${testCase.expectedEnvironment}`;
  const processResult = spawnSync(
    process.execPath,
    ["--import", "tsx", harnessPath],
    { cwd: turboDirectory, encoding: "utf8", env: environment },
  );
  return { process: processResult, trace: trace(fixture) };
}

function runForgeConfig(): SpawnSyncReturns<string> {
  const environment = baseEnvironment();
  environment.TEST_FORGE_CONFIG = join(desktopDirectory, "forge.config.js");
  environment.TEST_EXPECTED_APP_ICON_BASE_NAME = "icon";
  return spawnSync(process.execPath, ["--eval", forgeConfigHarnessSource], {
    cwd: desktopDirectory,
    encoding: "utf8",
    env: environment,
  });
}

function dormantDriverEvidence() {
  return {
    actual: null,
    phase: "stopped",
    lifecycleElapsedMs: 1,
    cleanupPending: false,
    error: null,
    canRetry: true,
  };
}

interface SmokeScenario {
  readonly settledDriver?: unknown;
  readonly output?: string;
  readonly exit?: number | "signal";
  readonly signatureExit?: number;
}

function preparePackagedApp(
  fixture: DesktopFixture,
  appName: string,
  marker: "selected" | "unexpected",
  scenario: SmokeScenario,
): void {
  const appBundlePath = join(
    fixture.desktopDirectory,
    "out",
    `${appName}-darwin-${process.arch}`,
    `${appName}.app`,
  );
  const executablePath = join(appBundlePath, "Contents", "MacOS", appName);
  const resourcesPath = join(appBundlePath, "Contents", "Resources");
  mkdirSync(join(resourcesPath, "app", "dist"), { recursive: true });
  mkdirSync(join(resourcesPath, "mcp"), { recursive: true });
  mkdirSync(join(appBundlePath, "Contents", "MacOS"), { recursive: true });
  const identity = Object.values(identities)
    .flatMap((product) => [product.production, product.development])
    .find((item) => item.displayName === appName)!;
  const { product, brandName, displayName, bundleId } = identity;
  const evidence = {
    schemaVersion: 1,
    desktopVersion: packageMetadata.version,
    electronVersion: packageMetadata.devDependencies.electron,
    bundleId,
    bridge: {
      auth: true,
      authCompletionRejected: true,
      computerUse: true,
      developerTools: true,
      driverControls: true,
      driver: dormantDriverEvidence(),
      settledDriver: scenario.settledDriver ?? dormantDriverEvidence(),
      identity: { product, brandName, displayName },
    },
  };
  const output =
    scenario.output ?? `[smoke-test] evidence ${JSON.stringify(evidence)}`;
  writeFileSync(
    executablePath,
    `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.TEST_TRACE_PATH, "${marker}\\n");\nconsole.log(${JSON.stringify(output)});\n${scenario.exit === "signal" ? 'process.kill(process.pid, "SIGTERM");' : `process.exit(${scenario.exit ?? 0});`}\n`,
  );
  chmodSync(executablePath, 0o755);
  writeFileSync(join(resourcesPath, "app", "dist", "main.js"), "");
  writeFileSync(join(resourcesPath, "mcp", "index.mjs"), "");
}

function runWrapper(
  wrapper: "run-packaged-app.js" | "smoke-test-packaged-app.js",
  values: EnvironmentValues,
  expectedAppName: "Okou" | "Okou Dev",
  scenario: SmokeScenario = {},
): EntryPointResult {
  const fixture = createDesktopFixture();
  for (const appName of ["Okou", "Okou Dev"]) {
    preparePackagedApp(
      fixture,
      appName,
      appName === expectedAppName ? "selected" : "unexpected",
      scenario,
    );
  }
  const environment = baseEnvironment();
  environment.TEST_TRACE_PATH = fixture.tracePath;
  applyEnvironmentValues(environment, values);
  const signatureArguments: string[] = [];
  if (scenario.signatureExit !== undefined) {
    const binaryDirectory = join(fixture.desktopDirectory, "bin");
    mkdirSync(binaryDirectory);
    const verifierPath = join(binaryDirectory, "codesign");
    writeFileSync(
      verifierPath,
      `#!${process.execPath}
const assert = require("node:assert/strict");
assert.deepEqual(process.argv.slice(2, 5), ["--verify", "--deep", "--strict"]);
assert.ok(process.argv[5].endsWith(${JSON.stringify(`/${expectedAppName}.app`)}));
require("node:fs").appendFileSync(process.env.TEST_TRACE_PATH, "signature-check\\n");
process.exit(${scenario.signatureExit});
`,
    );
    chmodSync(verifierPath, 0o755);
    environment.PATH = [binaryDirectory, environment.PATH]
      .filter(Boolean)
      .join(delimiter);
    signatureArguments.push("--signed");
  }
  const processResult = spawnSync(
    process.execPath,
    [
      "--require",
      fixture.platformOverridePath,
      join(fixture.desktopDirectory, "scripts", wrapper),
      ...signatureArguments,
    ],
    { encoding: "utf8", env: environment },
  );
  return { process: processResult, trace: trace(fixture) };
}

function expectSuccessfulEntryPoint(result: EntryPointResult): void {
  expect(result.process.status, result.process.stderr).toBe(0);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Desktop build configuration entry point", () => {
  const lifecycleCases = [
    {
      name: "uses product defaults when inputs are absent",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    },
    {
      name: "treats trimmed-empty canonical inputs as absent",
      environment: {
        canonicalProduct: " ",
        canonicalPlatformUrl: "\t",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    },
    {
      name: "trims canonical inputs",
      environment: {
        canonicalProduct: " okou ",
        canonicalPlatformUrl: " https://app.okou.ai ",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    },
    {
      name: "uses the runtime file when canonical inputs are absent",
      fileConfig: {
        product: "okou",
        platformUrl: "https://staging-app.omby.ai",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://staging-app.omby.ai/",
      expectedDisplayName: "Okou Dev",
    },
  ] satisfies readonly (SurfaceCase & { readonly name: string })[];

  it.each(lifecycleCases)("$name", (testCase) => {
    expectSuccessfulEntryPoint(runBuildConfig(testCase));
  });

  it("keeps canonical environment ahead of the runtime file", () => {
    const result = runBuildConfig({
      environment: {
        canonicalProduct: "okou",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
      fileConfig: {
        product: "okou",
        platformUrl: "https://staging-app.omby.ai",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    });

    expectSuccessfulEntryPoint(result);
  });

  it("keeps non-empty explicit options ahead of canonical environment", () => {
    const result = runBuildConfig({
      environment: {
        canonicalProduct: "okou",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
      productArgument: " okou ",
      platformArgument: " https://app.okou.ai ",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    });

    expectSuccessfulEntryPoint(result);
  });

  it("lets trimmed-empty explicit options fall through to canonical environment", () => {
    const result = runBuildConfig({
      environment: {
        canonicalProduct: "okou",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
      productArgument: " ",
      platformArgument: "\t",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
    });

    expectSuccessfulEntryPoint(result);
  });
});

describe("installed Desktop configuration entry point", () => {
  const lifecycleCases = [
    {
      name: "uses product defaults when inputs are absent",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    },
    {
      name: "treats trimmed-empty canonical inputs as absent",
      environment: {
        canonicalProduct: " ",
        canonicalPlatformUrl: "\n",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    },
    {
      name: "trims canonical inputs",
      environment: {
        canonicalProduct: " okou ",
        canonicalPlatformUrl: " https://app.okou.ai ",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    },
    {
      name: "uses the runtime file when canonical inputs are absent",
      fileConfig: {
        product: "okou",
        platformUrl: "https://staging-app.omby.ai",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://staging-app.omby.ai/",
      expectedDisplayName: "Okou Dev",
      expectedEnvironment: "staging",
    },
  ] satisfies readonly (InstalledSurfaceCase & { readonly name: string })[];

  it.each(lifecycleCases)("$name", (testCase) => {
    expectSuccessfulEntryPoint(runInstalledConfig(testCase));
  });

  it("keeps canonical environment ahead of the runtime file", () => {
    const result = runInstalledConfig({
      environment: {
        canonicalProduct: "okou",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
      fileConfig: {
        product: "okou",
        platformUrl: "https://staging-app.omby.ai",
      },
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    });

    expectSuccessfulEntryPoint(result);
  });

  it("keeps non-empty arguments ahead of canonical environment", () => {
    const result = runInstalledConfig({
      environment: {
        canonicalProduct: "okou",
        canonicalPlatformUrl: "https://app.okou.ai",
      },
      productArgument: " okou ",
      platformArgument: " https://app.okou.ai ",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    });

    expectSuccessfulEntryPoint(result);
  });

  it("lets a trimmed-empty product argument fall through to canonical environment", () => {
    const result = runInstalledConfig({
      environment: { canonicalProduct: "okou" },
      productArgument: " ",
      platformArgument: "https://app.okou.ai",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    });

    expectSuccessfulEntryPoint(result);
  });

  it("keeps a defined-empty platform argument ahead of environment and the runtime file", () => {
    const result = runInstalledConfig({
      environment: {
        canonicalPlatformUrl: "https://canonical.example.invalid",
      },
      fileConfig: {
        product: "okou",
        platformUrl: "https://staging-app.omby.ai",
      },
      productArgument: "okou",
      platformArgument: "",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    });

    expectSuccessfulEntryPoint(result);
  });

  it("names the canonical platform URL in protocol validation diagnostics", () => {
    const result = runInstalledConfig({
      environment: {
        canonicalPlatformUrl: "ftp://canonical.example.invalid",
      },
      productArgument: "okou",
      expectedProduct: "okou",
      expectedPlatformUrl: "https://app.okou.ai/",
      expectedDisplayName: "Okou",
      expectedEnvironment: "production",
    });

    expect(result.process.status).toBe(1);
    expect(result.process.stderr).toContain(
      "OKOU_DESKTOP_PLATFORM_URL must use http or https, received ftp:",
    );
  });
});

describe("Desktop product configuration validation", () => {
  it.each([
    { productArgument: "unsupported" },
    { environment: { canonicalProduct: "unsupported" } },
    ...["unsupported", "", 1, null].map((product) => ({
      fileConfig: { product, platformUrl: "https://app.okou.ai" },
    })),
  ])(
    "rejects invalid configured product input at build and runtime: %j",
    (input) => {
      const testCase: InstalledSurfaceCase = {
        ...input,
        expectedProduct: "okou",
        expectedPlatformUrl: "https://app.okou.ai/",
        expectedDisplayName: "Okou",
        expectedEnvironment: "production",
      };
      for (const result of [
        runBuildConfig(testCase),
        runInstalledConfig(testCase),
      ]) {
        expect(result.process.status).toBe(1);
        expect(result.process.stderr).toMatch(
          /Unsupported desktop product|product must be okou/,
        );
      }
    },
  );
});

describe("packaged Desktop wrapper entry points", () => {
  const wrappers = [
    "run-packaged-app.js",
    "smoke-test-packaged-app.js",
  ] as const;

  it.each(wrappers)("uses canonical values through %s", (wrapper) => {
    const result = runWrapper(
      wrapper,
      {
        canonicalProduct: " okou ",
        canonicalPlatformUrl: " https://staging-app.omby.ai ",
      },
      "Okou Dev",
    );

    expectSuccessfulEntryPoint(result);
    expect(result.trace).toBe("selected\n");
  });

  it("accepts structured lifecycle evidence only after successful process exit", () => {
    const result = runWrapper("smoke-test-packaged-app.js", {}, "Okou", {});
    expectSuccessfulEntryPoint(result);
    expect(result.trace).toBe("selected\n");
    expect(result.process.stdout).toContain('"computerUse":true');
    expect(result.process.stdout).toContain('"code":0,"signal":null');
  });

  it("verifies the signed package before launching the smoke test", () => {
    const result = runWrapper("smoke-test-packaged-app.js", {}, "Okou", {
      signatureExit: 0,
    });
    expectSuccessfulEntryPoint(result);
    expect(result.trace).toBe("signature-check\nselected\n");
  });

  it("does not launch a package that fails signature verification", () => {
    const result = runWrapper("smoke-test-packaged-app.js", {}, "Okou", {
      signatureExit: 1,
    });
    expect(result.process.status).toBe(1);
    expect(result.trace).toBe("signature-check\n");
  });

  it.each([1, "signal"] as const)(
    "rejects valid metadata with process exit %s",
    (exit) => {
      const result = runWrapper("smoke-test-packaged-app.js", {}, "Okou", {
        exit,
      });
      expect(result.process.status).toBe(1);
      expect(result.trace).toBe("selected\n");
    },
  );

  const malformedEvidence = [
    "[smoke-test] evidence {invalid JSON with private-input}",
    '[smoke-test] evidence {"bridge":null}',
    "private-input".repeat(12000),
    "no record",
  ];
  it.each(malformedEvidence.map((output, index) => ({ output, index })))(
    "rejects invalid or unproven lifecycle evidence $index without exposing raw output",
    ({ output }) => {
      const result = runWrapper("smoke-test-packaged-app.js", {}, "Okou", {
        output,
      });
      expect(result.process.status).toBe(1);
      expect(result.process.stdout + result.process.stderr).not.toContain(
        "private-input",
      );
    },
  );

  it.each([
    { ...dormantDriverEvidence(), phase: "ready" },
    {
      ...dormantDriverEvidence(),
      actual: { id: "invalid", generation: 1, version: null },
    },
    {
      ...dormantDriverEvidence(),
      actual: { id: "okou", generation: 0, version: null },
    },
    { ...dormantDriverEvidence(), cleanupPending: true },
  ])(
    "rejects non-default or invalid settled driver state %#",
    (settledDriver) => {
      const result = runWrapper("smoke-test-packaged-app.js", {}, "Okou", {
        settledDriver,
      });
      expect(result.process.status).toBe(1);
    },
  );

  it("does not accept ordinary readiness markers without actual driver state", () => {
    const result = runWrapper("smoke-test-packaged-app.js", {}, "Okou", {
      output: "[smoke-test] desktop main ready",
    });
    expect(result.process.status).toBe(1);
  });
});

describe("Desktop package brand assets", () => {
  it("uses the Okou app icon by default", () => {
    const result = runForgeConfig();

    expect(result.status, result.stderr).toBe(0);
  });
});
