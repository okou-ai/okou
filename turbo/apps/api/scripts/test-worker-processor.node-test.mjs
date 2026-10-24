import assert from "node:assert/strict";
import { Blob, Buffer } from "node:buffer";
import { URL, pathToFileURL } from "node:url";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import {
  apiRoot,
  workerBuildOptions,
  validateWorkerExternals,
} from "./worker-build-options.mjs";

const { AbortController, FormData, Request } = globalThis;
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler"));
const {
  Miniflare,
  Response: WorkerResponse,
  convertV4MiniflareOptions,
} = wranglerRequire("miniflare");
const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } =
  wranglerRequire("undici");
const ts = require("typescript");
const AdmZip = require("adm-zip");
const fixtures = resolve(apiRoot, "src/signals/routes/__tests__/fixtures");
const stylesheet =
  "@font-face { src: url(https://fonts.gstatic.com/s/import-test/font.ttf) format('truetype'); }";

async function writeBuild(result) {
  validateWorkerExternals(result);
  for (const file of result.outputFiles) {
    await mkdir(resolve(file.path, ".."), { recursive: true });
    await writeFile(file.path, file.contents);
  }
}

function archiveEntries(file) {
  return new AdmZip(file)
    .getEntries()
    .map((entry) => {
      return [entry.entryName, entry.getData().toString("base64")];
    })
    .sort();
}

async function invoke(worker, filename, bytes, signal) {
  const body = new FormData();
  body.set("filename", filename);
  body.set("file", new Blob([bytes]), "source.bin");
  const request = new Request("https://slides.internal/v1/prepare", {
    method: "POST",
    body,
    signal,
  });
  const response = await worker.fetch(request.url, {
    method: "POST",
    headers: Object.fromEntries(request.headers),
    body: await request.arrayBuffer(),
    signal,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.formData();
  const file = result.get("file");
  return {
    metadata: JSON.parse(result.get("result")),
    file: file ? Buffer.from(await file.arrayBuffer()) : undefined,
  };
}

async function buildNodeFixtures(directory) {
  const font = await readFile(resolve(fixtures, "slides-import-font.ttf"));
  const deck = await readFile(resolve(fixtures, "slides-text-provenance.pptx"));

  // Reuse the existing public-route test fixture without starting MSW or API
  // globals. Only fixture construction is extracted; production code is built
  // directly from its real source files with the production Worker options.
  const fixturePath = resolve(
    apiRoot,
    "src/signals/routes/__tests__/helpers/slides-import-fixture.ts",
  );
  const fixtureSource = await readFile(fixturePath, "utf8");
  const ast = ts.createSourceFile(
    fixturePath,
    fixtureSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const fixture = ast.statements.find((node) => {
    return (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "slidesImportFixture"
    );
  });
  assert.ok(fixture, "shared slidesImportFixture must exist");
  await build({
    stdin: {
      contents: 'import AdmZip from "adm-zip";\n' + fixture.getFullText(ast),
      loader: "ts",
      resolveDir: apiRoot,
    },
    outfile: resolve(directory, "fixture.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const {
    default: { slidesImportFixture },
  } = await import(pathToFileURL(resolve(directory, "fixture.cjs")).href);
  const preparation = resolve(
    apiRoot,
    "src/signals/services/google-slides-preparation.ts",
  );
  await build({
    entryPoints: [preparation],
    outfile: resolve(directory, "node-preparation.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const {
    default: { prepareGoogleSlides },
  } = await import(
    pathToFileURL(resolve(directory, "node-preparation.cjs")).href
  );

  return { font, deck, slidesImportFixture, prepareGoogleSlides };
}

async function buildNativeWorkers(directory) {
  const processorEntry = resolve(apiRoot, "src/worker-domains/processor.ts");
  const processor = await build(
    workerBuildOptions({
      entryPoint: processorEntry,
      outputDirectory: resolve(directory, "processor"),
    }),
  );
  await writeBuild(processor);
  // The caller has the actual Service Binding client. Reusing the processor's
  // multipart HTTP adapter keeps test-only request/response plumbing minimal.
  const caller = await build(
    workerBuildOptions({
      entryPoint: processorEntry,
      outputDirectory: resolve(directory, "caller"),
      plugins: [
        {
          name: "native-caller-http-adapter",
          setup(builder) {
            builder.onResolve(
              { filter: /google-slides-preparation$/ },
              ({ importer }) => {
                if (importer === processorEntry) {
                  return { path: "caller-adapter", namespace: "test" };
                }
              },
            );
            builder.onLoad({ filter: /.*/, namespace: "test" }, () => {
              return {
                contents: `import { prepareGoogleSlidesImport } from ${JSON.stringify(resolve(apiRoot, "src/worker-domains/slides-client.ts"))};
            export function prepareGoogleSlides(source, warn, signal) { return prepareGoogleSlidesImport(source, signal); }`,
                loader: "ts",
                resolveDir: apiRoot,
              };
            });
          },
        },
      ],
    }),
  );
  await writeBuild(caller);
}

function createProviderHarness(font) {
  const state = {
    cssStatus: 200,
    fontStatus: 200,
    unexpectedRequests: 0,
    enteredFont: undefined,
    stalledFont: undefined,
  };
  const external = async (request) => {
    const url = new URL(request.url);
    if (
      url.origin === "https://fonts.googleapis.com" &&
      url.pathname === "/css2"
    ) {
      if (state.stalledFont) {
        state.enteredFont.resolve();
        await state.stalledFont.promise;
      }
      return new WorkerResponse(stylesheet, {
        status: url.searchParams.get("family")?.startsWith("Import Test:")
          ? state.cssStatus
          : 400,
        headers: { location: "https://redirect.invalid/font" },
      });
    }
    if (url.href === "https://fonts.gstatic.com/s/import-test/font.ttf") {
      return new WorkerResponse(font, {
        status: state.fontStatus,
        headers: { location: "https://redirect.invalid/font" },
      });
    }
    state.unexpectedRequests++;
    throw new Error(
      `Unexpected processor HTTP destination ${url.origin}${url.pathname}`,
    );
  };

  const network = new MockAgent();
  network.disableNetConnect();
  network
    .get("https://fonts.googleapis.com")
    .intercept({ path: /\/css2\?.*/ })
    .reply(({ path }) => {
      return {
        statusCode: new URL(path, "https://fonts.googleapis.com").searchParams
          .get("family")
          ?.startsWith("Import Test:")
          ? state.cssStatus
          : 400,
        data: stylesheet,
      };
    })
    .persist();
  network
    .get("https://fonts.gstatic.com")
    .intercept({ path: "/s/import-test/font.ttf" })
    .reply(200, font)
    .persist();

  return { state, external, network };
}

function createNativeRuntime(directory, outbound) {
  const common = {
    modules: true,
    compatibilityDate: "2026-09-02",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    outboundService: outbound,
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: directory,
      workers: [
        {
          ...common,
          name: "caller",
          scriptPath: resolve(directory, "caller/worker.js"),
          serviceBindings: { SLIDES_PREPARER: "processor" },
        },
        {
          ...common,
          name: "processor",
          scriptPath: resolve(directory, "processor/worker.js"),
        },
      ],
    }),
  );

  return mf;
}

function createNodeOracle(prepareGoogleSlides, network) {
  return async function nodeOracle(filename, file) {
    const previous = getGlobalDispatcher();
    setGlobalDispatcher(network);
    try {
      const result = await prepareGoogleSlides(
        { filename, file },
        () => {},
        new AbortController().signal,
      );
      return result.ok
        ? {
            metadata: {
              ok: true,
              ...(result.textStyles === undefined
                ? {}
                : { textStyles: result.textStyles }),
            },
            file: result.file,
          }
        : { metadata: result };
    } finally {
      setGlobalDispatcher(previous);
    }
  };
}

async function verifyEquivalence(
  t,
  { deck, slidesImportFixture },
  { nativeCaller, nativeProcessor },
  nodeOracle,
) {
  for (const [name, filename, bytes] of [
    ["non-PPTX pass-through", "source.txt", Buffer.from("original text")],
    ["non-ZIP pass-through", "source.pptx", Buffer.from("not a ZIP")],
    ["malformed ZIP", "source.pptx", Buffer.from("PKbroken")],
    ["real CLI provenance and text styles", "source.pptx", deck],
    [
      "real font metrics and text expansion",
      "source.pptx",
      slidesImportFixture(),
    ],
    [
      "font kerning across split runs",
      "source.pptx",
      slidesImportFixture({ topicNumber: "06", splitTopicNumber: true }),
    ],
  ]) {
    await t.test(name, async () => {
      const original = await nodeOracle(filename, bytes);
      const direct = await invoke(nativeProcessor, filename, bytes);
      const split = await invoke(nativeCaller, filename, bytes);
      assert.deepEqual(split.metadata, original.metadata);
      assert.deepEqual(split.metadata, direct.metadata);
      if (original.metadata.ok && bytes[0] === 80 && bytes[1] === 75) {
        // ZIP container timestamps depend on runtime clocks, not conversion.
        assert.deepEqual(
          archiveEntries(split.file),
          archiveEntries(original.file),
        );
        assert.deepEqual(
          archiveEntries(split.file),
          archiveEntries(direct.file),
        );
      } else {
        assert.deepEqual(split.file, original.file);
        assert.deepEqual(split.file, direct.file);
      }
      if (name.includes("text styles")) {
        assert.ok(split.metadata.textStyles.length > 0);
      }
    });
  }
}

async function verifyFailures(
  t,
  slidesImportFixture,
  nativeCaller,
  nodeOracle,
  state,
) {
  await t.test(
    "font provider failure preserves the caller's error result",
    async () => {
      state.cssStatus = 503;
      try {
        const result = await invoke(
          nativeCaller,
          "source.pptx",
          slidesImportFixture(),
        );
        const original = await nodeOracle("source.pptx", slidesImportFixture());
        assert.deepEqual(result.metadata, original.metadata);
        assert.equal(result.metadata.ok, false);
      } finally {
        state.cssStatus = 200;
      }
    },
  );
  for (const target of ["stylesheet", "font binary"]) {
    await t.test(
      `${target} redirects fail without forwarding the request`,
      async () => {
        if (target === "stylesheet") {
          state.cssStatus = 302;
        } else {
          state.fontStatus = 302;
        }
        try {
          const result = await invoke(
            nativeCaller,
            "source.pptx",
            slidesImportFixture(),
          );
          assert.equal(result.metadata.ok, false);
          assert.equal(state.unexpectedRequests, 0);
        } finally {
          state.cssStatus = 200;
          state.fontStatus = 200;
        }
      },
    );
  }
}

async function verifyProtocolAndCancellation(
  t,
  slidesImportFixture,
  { nativeCaller, nativeProcessor },
  state,
) {
  await t.test(
    "processor rejects an unrelated route and missing file",
    async () => {
      assert.equal(
        (await nativeProcessor.fetch("https://slides.internal/unknown")).status,
        404,
      );
      const form = new FormData();
      form.set("filename", "source.pptx");
      const request = new Request("https://slides.internal/v1/prepare", {
        method: "POST",
        body: form,
      });
      const response = await nativeProcessor.fetch(request.url, {
        method: "POST",
        headers: Object.fromEntries(request.headers),
        body: await request.arrayBuffer(),
      });
      assert.equal(response.status, 400);
    },
  );
  await t.test(
    "caller cancellation remains observable after processing starts",
    async () => {
      state.enteredFont = Promise.withResolvers();
      state.stalledFont = Promise.withResolvers();
      const controller = new AbortController();
      const pending = invoke(
        nativeCaller,
        "source.pptx",
        slidesImportFixture(),
        controller.signal,
      );
      const rejected = assert.rejects(pending, { name: "AbortError" });
      try {
        await state.enteredFont.promise;
        controller.abort();
        await rejected;
      } finally {
        state.stalledFont.resolve();
        state.stalledFont = undefined;
      }
      // Miniflare's outbound bridge does not establish downstream disconnect
      // propagation; a real network-boundary check remains a rollout prerequisite.
    },
  );
}

test(
  "Slides preparation crosses a real native Worker Service Binding",
  { timeout: 60_000 },
  async (t) => {
    const directory = await mkdtemp(resolve(tmpdir(), "okou-slides-worker-"));
    const owned = { harness: undefined, runtime: undefined };
    t.after(async () => {
      owned.harness?.state.stalledFont?.resolve();
      await owned.runtime?.dispose();
      await owned.harness?.network.close();
      await rm(directory, { recursive: true, force: true });
    });
    const fixture = await buildNodeFixtures(directory);
    await buildNativeWorkers(directory);
    const harness = createProviderHarness(fixture.font);
    owned.harness = harness;
    const runtime = createNativeRuntime(directory, harness.external);
    owned.runtime = runtime;
    const workers = {
      nativeCaller: await runtime.getWorker("caller"),
      nativeProcessor: await runtime.getWorker("processor"),
    };
    const oracle = createNodeOracle(
      fixture.prepareGoogleSlides,
      harness.network,
    );
    await verifyEquivalence(t, fixture, workers, oracle);
    await verifyFailures(
      t,
      fixture.slidesImportFixture,
      workers.nativeCaller,
      oracle,
      harness.state,
    );
    await verifyProtocolAndCancellation(
      t,
      fixture.slidesImportFixture,
      workers,
      harness.state,
    );
  },
);
