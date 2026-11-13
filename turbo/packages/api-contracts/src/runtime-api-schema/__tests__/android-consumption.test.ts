import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  renderKotlinFiles,
  generatedKotlinRelativeDirectory,
} from "../../kotlin-bindings/generate";
import { runRuntimeApiSchemaCli } from "../command";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "android-consumption-"));
  for (const [file, source] of renderKotlinFiles())
    await put(`${generatedKotlinRelativeDirectory}/${file}`, source);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function put(file: string, source: string) {
  const path = join(root, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
}
function lint() {
  return runRuntimeApiSchemaCli(["lint-android-consumption", "--root", root]);
}

describe("Android generated consumption CLI", () => {
  it("accepts formatting/comments but rejects stale generated response types", async () => {
    expect(await lint()).toBe(0);
    const source = renderKotlinFiles().get("ApiModels.kt")!;
    await put(
      `${generatedKotlinRelativeDirectory}/ApiModels.kt`,
      `/* formatting */\n${source.replaceAll("    ", "  ")}`,
    );
    expect(await lint()).toBe(0);
    await put(
      `${generatedKotlinRelativeDirectory}/ApiModels.kt`,
      source.replace("String", "Boolean"),
    );
    expect(await lint()).toBe(1);
  });

  it.each([
    'import retrofit2.http.GET as Fetch\ninterface Extra { @Fetch("/api/unknown") suspend fun get(): String }',
    'interface Extra { @retrofit2.http.DELETE("/api/org") suspend fun delete(): String }',
    'val path = "/api/unregistered"',
  ])(
    "rejects uninventoried methods/paths including aliases and qualified annotations",
    async (source) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      await put("android/app/src/main/kotlin/Extra.kt", source);
      expect(await lint()).toBe(1);
      expect(errors.mock.calls.flat().join("\n")).toContain(
        "android/app/src/main/kotlin/Extra.kt,line=1",
      );
    },
  );

  it("rejects route drift even when the path already belongs to another method", async () => {
    const source = renderKotlinFiles().get("CanonicalApi.kt")!;
    await put(
      `${generatedKotlinRelativeDirectory}/CanonicalApi.kt`,
      source.replace('@GET("/api/org")', '@DELETE("/api/org")'),
    );
    expect(await lint()).toBe(1);
  });

  it.each(["test", "sharedTest"])(
    "checks production packages named %s instead of confusing them with test source sets",
    async (name) => {
      await put(
        `android/app/src/main/kotlin/ai/okou/android/${name}/Connection.kt`,
        'import retrofit2.http.GET\ninterface Extra { @GET("/api/unregistered") suspend fun get(): String }',
      );
      expect(await lint()).toBe(1);
    },
  );

  it("does not interpret comments or local test fixtures as production API consumers", async () => {
    await put(
      "android/app/src/main/kotlin/Comment.kt",
      '/* outer /* retrofit2.http.GET */ comment */\n// val path = "/api/ignored"',
    );
    await put(
      "android/app/src/test/kotlin/Fixture.kt",
      'val path = "/api/fixture"',
    );
    await put(
      "android/app/src/sharedTest/kotlin/ApiFixture.kt",
      'val path = "/api/fixture"',
    );
    expect(await lint()).toBe(0);
  });
});
