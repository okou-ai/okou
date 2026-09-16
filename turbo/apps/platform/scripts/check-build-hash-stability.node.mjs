import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";
import { Window } from "happy-dom";

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const COMMIT_SHA_META_NAME = "okou-app-git-commit-sha";
const VERSION_META_NAME = "okou-app-version";
const APP_FILE_PATTERN = /^index-[^/]+\.js$/u;
const VENDOR_GROUP_IDS = Object.freeze([1, 2, 3, 4, 5]);
const VENDOR_LABELS = VENDOR_GROUP_IDS.map((group) => {
  return `vendor-${group}`;
});
const RUNTIME_FILE_PATTERN = /^rolldown-runtime-[^/]+\.js$/u;
const WORKER_FILE_PATTERN = /^shared-database-worker-[^/]+\.js$/u;
const CLERK_UI_FILE_PATTERN = /^clerk-ui-[^/]+\.js$/u;
const MERMAID_LITE_MODULE_PATH =
  "/packages/mermaid-lite/dist/mermaid.esm.min.mjs";
const BASELINE_COMMIT_SHA = "1111111111111111111111111111111111111111";
const ALTERNATE_COMMIT_SHA = "2222222222222222222222222222222222222222";

const appDirectory = process.cwd();
const packageJson = JSON.parse(
  await readFile(path.join(appDirectory, "package.json"), "utf8"),
);
const vendorManifest = JSON.parse(
  await readFile(path.join(appDirectory, "scripts/vendor-groups.json"), "utf8"),
);
const mermaidVendorLabel = `vendor-${vendorManifest.packages["@okouai/mermaid-lite"]}`;
const appVersion = process.env.OKOU_APP_VERSION ?? packageJson.version;
const appCommitSha = process.env.OKOU_APP_GIT_COMMIT_SHA;
assert.match(
  appCommitSha ?? "",
  COMMIT_SHA_PATTERN,
  "OKOU_APP_GIT_COMMIT_SHA must be a full lowercase commit SHA",
);
assert.equal(typeof appVersion, "string");
assert.ok(appVersion.length > 0, "App version must not be empty");

const baselineCommitSha =
  appCommitSha === BASELINE_COMMIT_SHA
    ? ALTERNATE_COMMIT_SHA
    : BASELINE_COMMIT_SHA;
const alternateVersion = `${appVersion}-bundle-stability"><script data-okou-build-metadata-injection></script>`;
const sourceMaps = process.argv.includes("--sourcemap");
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "okou-app-hash-stability-"),
);
const mutationConfigFile = path.join(temporaryRoot, "vite-mutation.config.mjs");

await writeFile(
  mutationConfigFile,
  `import baseConfig from ${JSON.stringify(
    pathToFileURL(path.join(appDirectory, "vite.config.ts")).href,
  )};

const mutationTargets = {
  app: "/apps/platform/src/main.ts",
  mermaid: ${JSON.stringify(MERMAID_LITE_MODULE_PATH)},
};

export default (environment) => {
  const config =
    typeof baseConfig === "function" ? baseConfig(environment) : baseConfig;
  const mutation = process.env.OKOU_BUILD_HASH_MUTATION;
  const target = mutationTargets[mutation];
  if (!target) {
    throw new Error(\`Unknown build hash mutation: \${mutation}\`);
  }
  return {
    ...config,
    plugins: [
      {
        enforce: "pre",
        name: "okou-build-hash-mutation",
        transform(code, id) {
          const moduleId = id.replaceAll("\\\\", "/").split("?", 1)[0];
          if (!moduleId.endsWith(target)) {
            return;
          }
          return {
            code:
              code +
              "\\nglobalThis.__okouBuildHashMutation = " +
              JSON.stringify(mutation) +
              ";",
            map: null,
          };
        },
      },
      ...(config.plugins ?? []),
    ],
  };
};
`,
);

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function compressedSizes(content) {
  return {
    raw: content.byteLength,
    gzip9: gzipSync(content, { level: 9 }).byteLength,
    brotli11: brotliCompressSync(content, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      },
    }).byteLength,
  };
}

async function describeFile(assetsDirectory, fileName) {
  const content = await readFile(path.join(assetsDirectory, fileName));
  return {
    fileName,
    sha256: digest(content),
    ...compressedSizes(content),
  };
}

async function describeRuntimeMetadata(outputDirectory) {
  const html = await readFile(path.join(outputDirectory, "index.html"), "utf8");
  const window = new Window();
  const document = new window.DOMParser().parseFromString(html, "text/html");

  function exactlyOneMetaContent(name) {
    const elements = document.querySelectorAll(`meta[name="${name}"]`);
    assert.equal(elements.length, 1, `Expected exactly one ${name} meta tag`);
    const content = elements[0]?.getAttribute("content");
    assert.notEqual(content, null, `${name} meta tag must have content`);
    return content;
  }

  const runtimeMetadata = {
    commitSha: exactlyOneMetaContent(COMMIT_SHA_META_NAME),
    version: exactlyOneMetaContent(VERSION_META_NAME),
  };
  assert.equal(
    document.querySelector("script[data-okou-build-metadata-injection]"),
    null,
    "Runtime metadata must remain escaped inside its meta attribute",
  );
  window.close();
  return runtimeMetadata;
}

function exactlyOne(files, pattern, label) {
  const matches = files.filter((fileName) => {
    return pattern.test(fileName);
  });
  assert.equal(
    matches.length,
    1,
    `Expected exactly one ${label}, found: ${matches.join(", ") || "none"}`,
  );
  return matches[0];
}

async function describeBuild(outputDirectory) {
  const assetsDirectory = path.join(outputDirectory, "assets");
  const files = await readdir(assetsDirectory);
  const javaScriptFiles = files.filter((fileName) => {
    return fileName.endsWith(".js");
  });
  const vendors = {};
  for (const group of VENDOR_GROUP_IDS) {
    const fileName = exactlyOne(
      javaScriptFiles,
      new RegExp(`^vendor-${group}-[^/]+\\.js$`, "u"),
      `vendor-${group} JavaScript file`,
    );
    vendors[`vendor-${group}`] = await describeFile(assetsDirectory, fileName);
  }
  const runtimeFile = exactlyOne(
    javaScriptFiles,
    RUNTIME_FILE_PATTERN,
    "Rolldown runtime JavaScript file",
  );
  const workerFile = exactlyOne(
    javaScriptFiles,
    WORKER_FILE_PATTERN,
    "SharedWorker JavaScript file",
  );
  // `APP_FILE_PATTERN` cannot match the optional Clerk UI asset, so the app
  // entry stays exactly one file even while that asset is emitted.
  const appFile = exactlyOne(
    javaScriptFiles,
    APP_FILE_PATTERN,
    "app entry JavaScript file",
  );

  const artifacts = {
    clerkUi: await describeFile(
      assetsDirectory,
      exactlyOne(javaScriptFiles, CLERK_UI_FILE_PATTERN, "optional Clerk UI"),
    ),
    app: await describeFile(assetsDirectory, appFile),
    ...vendors,
    runtime: await describeFile(assetsDirectory, runtimeFile),
    worker: await describeFile(assetsDirectory, workerFile),
  };
  if (sourceMaps) {
    for (const label of ["app", ...VENDOR_LABELS, "worker"]) {
      const mapFile = `${artifacts[label].fileName}.map`;
      assert.ok(files.includes(mapFile), `Expected source map: ${mapFile}`);
    }
    const vendorSourceMap = JSON.parse(
      await readFile(
        path.join(
          assetsDirectory,
          `${artifacts[mermaidVendorLabel].fileName}.map`,
        ),
        "utf8",
      ),
    );
    assert.ok(
      vendorSourceMap.sources.some((source) => {
        return source.replaceAll("\\", "/").endsWith(MERMAID_LITE_MODULE_PATH);
      }),
      "Expected the vendor source map to include the generated Mermaid module",
    );
  }
  return {
    artifacts,
    runtimeMetadata: await describeRuntimeMetadata(outputDirectory),
  };
}

async function runBuild({
  commitSha,
  label,
  mutation,
  outputDirectory,
  version,
}) {
  await rm(outputDirectory, { force: true, recursive: true });
  const arguments_ = [
    "exec",
    "vite",
    "build",
    "--outDir",
    outputDirectory,
    "--emptyOutDir",
    "--logLevel",
    "warn",
  ];
  if (mutation) {
    arguments_.push("--config", mutationConfigFile);
  }
  if (sourceMaps) {
    arguments_.push("--sourcemap");
  }
  const child = spawn("pnpm", arguments_, {
    cwd: appDirectory,
    env: {
      ...process.env,
      OKOU_APP_GIT_COMMIT_SHA: commitSha,
      OKOU_APP_VERSION: version,
      OKOU_BUILD_HASH_MUTATION: mutation ?? "",
      SENTRY_AUTH_TOKEN: "",
    },
    stdio: "inherit",
  });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(
      `${label} build failed (${signal ? `signal ${signal}` : `exit ${code}`})`,
    );
  }
  return await describeBuild(outputDirectory);
}

function assertStable(builds, label) {
  const expected = builds[0].artifacts[label];
  for (const build of builds.slice(1)) {
    assert.equal(build.artifacts[label].fileName, expected.fileName);
    assert.equal(build.artifacts[label].sha256, expected.sha256);
  }
}

try {
  const baseline = await runBuild({
    commitSha: baselineCommitSha,
    label: "baseline commit",
    outputDirectory: path.join(temporaryRoot, "baseline"),
    version: appVersion,
  });
  const versionChange = await runBuild({
    commitSha: appCommitSha,
    label: "version change",
    outputDirectory: path.join(temporaryRoot, "version-change"),
    version: alternateVersion,
  });
  const appMutation = await runBuild({
    commitSha: appCommitSha,
    label: "app-only mutation",
    mutation: "app",
    outputDirectory: path.join(temporaryRoot, "app-mutation"),
    version: appVersion,
  });
  const mermaidMutation = await runBuild({
    commitSha: appCommitSha,
    label: "Mermaid mutation",
    mutation: "mermaid",
    outputDirectory: path.join(temporaryRoot, "mermaid-mutation"),
    version: appVersion,
  });
  const canonical = await runBuild({
    commitSha: appCommitSha,
    label: "canonical",
    outputDirectory: path.join(appDirectory, "dist"),
    version: appVersion,
  });
  for (const label of [
    "app",
    ...VENDOR_LABELS,
    "runtime",
    "worker",
    "clerkUi",
  ]) {
    assertStable([baseline, canonical], label);
  }
  for (const label of [...VENDOR_LABELS, "runtime", "clerkUi"]) {
    assertStable([versionChange, canonical], label);
  }
  assert.deepEqual(baseline.runtimeMetadata, {
    commitSha: baselineCommitSha,
    version: appVersion,
  });
  assert.deepEqual(versionChange.runtimeMetadata, {
    commitSha: appCommitSha,
    version: alternateVersion,
  });
  assert.deepEqual(canonical.runtimeMetadata, {
    commitSha: appCommitSha,
    version: appVersion,
  });
  for (const label of ["app", "worker"]) {
    assert.notEqual(
      versionChange.artifacts[label].fileName,
      canonical.artifacts[label].fileName,
    );
    assert.notEqual(
      versionChange.artifacts[label].sha256,
      canonical.artifacts[label].sha256,
    );
  }
  for (const label of [...VENDOR_LABELS, "runtime", "worker", "clerkUi"]) {
    assertStable([canonical, appMutation], label);
  }
  for (const label of [
    ...VENDOR_LABELS.filter((name) => {
      return name !== mermaidVendorLabel;
    }),
    "runtime",
    "worker",
    "clerkUi",
  ]) {
    assertStable([canonical, mermaidMutation], label);
  }
  assert.notEqual(
    appMutation.artifacts.app.fileName,
    canonical.artifacts.app.fileName,
  );
  assert.notEqual(
    appMutation.artifacts.app.sha256,
    canonical.artifacts.app.sha256,
  );
  assert.notEqual(
    mermaidMutation.artifacts[mermaidVendorLabel].fileName,
    canonical.artifacts[mermaidVendorLabel].fileName,
  );
  assert.notEqual(
    mermaidMutation.artifacts[mermaidVendorLabel].sha256,
    canonical.artifacts[mermaidVendorLabel].sha256,
  );
  assert.notEqual(
    mermaidMutation.artifacts.app.fileName,
    canonical.artifacts.app.fileName,
  );
  assert.notEqual(
    mermaidMutation.artifacts.app.sha256,
    canonical.artifacts.app.sha256,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        builds: {
          baselineCommit: {
            commitSha: baselineCommitSha,
            version: appVersion,
            ...baseline,
          },
          canonical: {
            commitSha: appCommitSha,
            version: appVersion,
            ...canonical,
          },
          appMutation: {
            commitSha: appCommitSha,
            version: appVersion,
            ...appMutation,
          },
          mermaidMutation: {
            commitSha: appCommitSha,
            version: appVersion,
            ...mermaidMutation,
          },
          versionChange: {
            commitSha: appCommitSha,
            version: alternateVersion,
            ...versionChange,
          },
        },
        verifiedStable: {
          appMutation: [...VENDOR_LABELS, "runtime", "worker", "clerkUi"],
          commitChange: [
            "app",
            ...VENDOR_LABELS,
            "runtime",
            "worker",
            "clerkUi",
          ],
          mermaidMutation: [
            ...VENDOR_LABELS.filter((name) => {
              return name !== mermaidVendorLabel;
            }),
            "runtime",
            "worker",
            "clerkUi",
          ],
          versionChange: [...VENDOR_LABELS, "runtime", "clerkUi"],
        },
        verifiedInvalidated: {
          appMutation: ["app"],
          mermaidMutation: ["app", mermaidVendorLabel],
          versionChange: ["app", "worker"],
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
