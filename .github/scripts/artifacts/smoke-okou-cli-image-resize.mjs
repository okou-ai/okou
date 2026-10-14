import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

function resolvePackageDirectory() {
  const explicitDirectory = process.argv[2];
  if (explicitDirectory) {
    return explicitDirectory;
  }

  const okouExecutable = process.env.PATH?.split(delimiter)
    .map((directory) => join(directory, "okou"))
    .find((path) => existsSync(path));
  assert(okouExecutable, "npx environment is missing the okou executable");
  return dirname(realpathSync(okouExecutable));
}

const packageDirectory = resolvePackageDirectory();

const timeout = setTimeout(() => {
  throw new Error("Packaged image resize smoke test timed out");
}, 10_000);

function pngDimensions(bytes) {
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

const packageEntries = await readdir(packageDirectory);
const agentLoopChunks = packageEntries.filter(
  (entry) => entry.startsWith("__agent-loop-") && entry.endsWith(".js"),
);
assert.equal(
  agentLoopChunks.length,
  1,
  "expected one packaged agent loop chunk",
);

const agentLoopPath = join(packageDirectory, agentLoopChunks[0]);
const agentLoopSource = await readFile(agentLoopPath, "utf8");
const readToolMarker =
  "node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js";
const readToolModules = [];
for (const entry of packageEntries) {
  if (!entry.endsWith(".js")) continue;
  const path = join(packageDirectory, entry);
  const source =
    entry === agentLoopChunks[0]
      ? agentLoopSource
      : await readFile(path, "utf8");
  if (source.includes(readToolMarker)) {
    readToolModules.push({ path, source });
  }
}
assert.equal(
  readToolModules.length,
  1,
  "expected one packaged Pi read tool module",
);
const readToolModule = readToolModules[0];
const readToolStart = readToolModule.source.lastIndexOf(readToolMarker);
const nextModuleStart = readToolModule.source.indexOf(
  "\n// ",
  readToolStart + 1,
);
assert.notEqual(nextModuleStart, -1, "packaged Pi read tool has no boundary");
const readToolSource = readToolModule.source.slice(
  readToolStart,
  nextModuleStart,
);
const createReadToolMatch = readToolSource.match(
  /function (createReadTool(?:Definition)?\d*)\(cwd, options\)/,
);
assert(createReadToolMatch, "packaged Pi read tool is missing its constructor");
await appendFile(
  readToolModule.path,
  `\nexport { ${createReadToolMatch[1]} as __smokeCreateReadTool };\n`,
);

const { __smokeCreateReadTool: createReadTool } = await import(
  pathToFileURL(readToolModule.path).href
);
assert.equal(typeof createReadTool, "function");

const tinyImagePath = join(packageDirectory, "tiny.png");
const oversizedImagePath = join(packageDirectory, "oversized.png");
await writeFile(
  tinyImagePath,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA8UlEQVR42r2UzQqCQBzEPfUheikI0lNEp67RQ4iXfM7qEmQFQa9gl4KO1i2MiA5GVCNssAy6llALv9OMs+7fWTXtT6sMXOABs0iADiywBk/BHnQ+DWiAhfQwcwMRGAlv5horQpiZKuhE5iuYggk4k/YAlbSQ5PyxZEzmY0t6DawozOIQUwzzbbiDdspmdXCRfAEoyQaPdgoUx/fJ68iiS+JGEbQk74CLF9AgeykhLZpjCAw22bTTAfQlvQu2kh5nFVQXb8J92YmjshapejT/opDDvCuS1P8orkNWiJ93RbigIVWiCapF/gKG+LwOF+9n6wW7L3pUFsFiAgAAAABJRU5ErkJggg==",
    "base64",
  ),
);
await writeFile(
  oversizedImagePath,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAB9EAAAACCAYAAADvqyztAAAALklEQVR4nO3OsQ0AMAjAsPz/NJV4gg4evLtqAAAAAAAAAIB1HgAAAAAAAACALzxAcpNAdlqyuwAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const workerInput = new Uint8Array(await readFile(tinyImagePath));
const worker = new Worker(
  pathToFileURL(join(packageDirectory, "image-resize-worker.js")),
);
const workerResponse = await new Promise((resolve, reject) => {
  worker.once("message", resolve);
  worker.once("error", reject);
  worker.once("exit", (code) => {
    if (code !== 0) {
      reject(new Error(`Image resize worker exited with code ${code}`));
    }
  });
  worker.postMessage(
    {
      inputBytes: workerInput,
      mimeType: "image/png",
      options: { maxWidth: 9, maxHeight: 9 },
    },
    [workerInput.buffer],
  );
});
await worker.terminate();
assert.equal(workerResponse.error, undefined);
assert.deepEqual(
  {
    originalWidth: workerResponse.result?.originalWidth,
    originalHeight: workerResponse.result?.originalHeight,
    width: workerResponse.result?.width,
    height: workerResponse.result?.height,
    wasResized: workerResponse.result?.wasResized,
  },
  {
    originalWidth: 18,
    originalHeight: 18,
    width: 9,
    height: 9,
    wasResized: true,
  },
);

const readTool = createReadTool(packageDirectory);
async function readImage(path) {
  const result = await readTool.execute("image-resize-smoke", { path });
  const image = result.content.find((item) => item.type === "image");
  assert(image, `Pi read omitted ${basename(path)}`);
  return Buffer.from(image.data, "base64");
}

assert.deepEqual(pngDimensions(await readImage(tinyImagePath)), {
  width: 18,
  height: 18,
});
assert.deepEqual(pngDimensions(await readImage(oversizedImagePath)), {
  width: 2000,
  height: 2,
});

await rm(join(packageDirectory, "image-resize-worker.js"));
assert.deepEqual(pngDimensions(await readImage(tinyImagePath)), {
  width: 18,
  height: 18,
});

clearTimeout(timeout);
console.log("Smoke-tested packaged Pi image resize worker and fallback");
