import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
} from "node:timers";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  createBashTool,
  createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";

const scenario = process.argv[2];
const root = await mkdtemp(join(tmpdir(), "bash-spool-contract-"));
const realCreateWriteStream = fs.createWriteStream;
const realSpawn = childProcess.spawn;
const controller = new globalThis.AbortController();
const chunkSize = 64 * 1024;
const spoolHighWaterMark = 64 * 1024;
const prefixLimit = 50 * 1024;
// Prefix + its flush copy, spool HWM + admitted chunk, two readable HWMs +
// overshoots, a delivered chunk, and two child-side write HWMs + overshoots.
const combinedBound = 2 * prefixLimit + 11 * chunkSize;
assert.ok(combinedBound <= 1024 * 1024);
const children = [];
const sinks = [];
const observedHash = createHash("sha256");
const pipeHashes = [createHash("sha256"), createHash("sha256")];
const pipeBytes = [0, 0];
let peakPending = 0;
let peakCombined = 0;
let maxChunk = 0;
let fullHash;
let producerPeaks;
let maxDrainListeners = 0;
let peakReads = 0;
let acceptedBytes = 0;
let completed = false;
let failure;
let settleCount = 0;
let updates = 0;
let initialUpdate = false;
let blockedWrite;
const blocked = Promise.withResolvers();
const childExited = Promise.withResolvers();
let hold = [
  "exit",
  "abort",
  "timeout",
  "write-error",
  "premature-close",
  "flush-abort",
  "flush-timeout",
  "flush-write-error",
  "drain-abort",
].includes(scenario);
let nextError = scenario.endsWith("write-error");
const sampler = setInterval(() => {
  return measure();
}, 1);
const watchdog = setTimeout(() => {
  failure = new Error("Fixture exceeded its 20-second watchdog");
  controller.abort();
  releaseWrite();
}, 20_000);

function measure(delivered = 0) {
  const pending = sinks.reduce((sum, stream) => {
    return sum + stream.writableLength;
  }, 0);
  const reads = children.reduce((sum, child) => {
    return sum + child.stdout.readableLength + child.stderr.readableLength;
  }, 0);
  peakPending = Math.max(peakPending, pending);
  peakReads = Math.max(peakReads, reads);
  // Include the fixed prefix/copy and conservative child-side queues even when
  // already released; do not measure RSS or hide the real Writable queue.
  peakCombined = Math.max(
    peakCombined,
    pending + reads + delivered + 2 * prefixLimit + 4 * chunkSize,
  );
  maxDrainListeners = Math.max(
    maxDrainListeners,
    ...sinks.map((stream) => {
      return stream.listenerCount("drain");
    }),
  );
}

function releaseWrite() {
  hold = false;
  const write = blockedWrite;
  blockedWrite = undefined;
  write?.();
}

childProcess.spawn = (...args) => {
  const child = realSpawn(...args);
  if (!child.stdout || !child.stderr) return child;
  children.push(child);
  [child.stdout, child.stderr].forEach((pipe, index) => {
    assert.ok(pipe.readableHighWaterMark <= chunkSize);
    pipe.on("data", (data) => {
      maxChunk = Math.max(maxChunk, data.length);
      observedHash.update(data);
      pipeHashes[index].update(data);
      pipeBytes[index] += data.length;
      acceptedBytes += data.length;
      measure(data.length);
    });
  });
  child.once("exit", () => {
    return childExited.resolve();
  });
  return child;
};

fs.createWriteStream = (path, options) => {
  if (!String(path).includes("pi-bash-"))
    return realCreateWriteStream(path, options);
  const stream = realCreateWriteStream(
    scenario === "open-error" ? join(root, "missing", "output.log") : path,
    {
      ...options,
      fs: {
        open: fs.open,
        close: fs.close,
        write(fd, buffer, offset, length, position, callback) {
          const perform = () => {
            if (nextError) {
              nextError = false;
              callback(new Error("controlled asynchronous disk write failure"));
            } else {
              fs.write(fd, buffer, offset, length, position, callback);
            }
          };
          if (hold) {
            assert.equal(blockedWrite, undefined);
            blockedWrite = perform;
            blocked.resolve(stream);
          } else {
            setTimeout(perform, 1);
          }
        },
      },
    },
  );
  sinks.push(stream);
  const write = stream.write.bind(stream);
  stream.write = (...args) => {
    const ready = write(...args);
    measure();
    return ready;
  };
  return stream;
};
syncBuiltinESMExports();

function quote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

async function command(source) {
  const path = join(root, "producer.mjs");
  await writeFile(path, source);
  return `exec ${quote(process.execPath)} ${quote(path)}`;
}

function producer(bytes, mode) {
  return `import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
const size = ${chunkSize};
async function produce(pipe, tag, count) {
  if (pipe.writableHighWaterMark > size) throw new Error('Unexpected producer HWM');
  let peak = 0;
  for (let i = 0; i < count; i++) {
    const chunk = Buffer.alloc(size, tag);
    chunk.writeUInt32LE(i, 0);
    const ready = pipe.write(chunk);
    peak = Math.max(peak, pipe.writableLength);
    if (!ready) await once(pipe, 'drain');
  }
  return peak;
}
const peaks = await Promise.all([
  produce(process.stdout, 65, ${mode === "stderr" ? 0 : bytes / chunkSize / (mode === "mixed" ? 2 : 1)}),
  produce(process.stderr, 66, ${mode === "stdout" ? 0 : bytes / chunkSize / (mode === "mixed" ? 2 : 1)})
]);
writeFileSync(${JSON.stringify(join(root, "producer-peaks.json"))}, JSON.stringify(peaks));`;
}

function expectedHash(bytes, tag) {
  const hash = createHash("sha256");
  for (let i = 0; i < bytes / chunkSize; i++) {
    const chunk = Buffer.alloc(chunkSize, tag);
    chunk.writeUInt32LE(i, 0);
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function execute(cmd, timeout) {
  return createBashTool(root)
    .execute(
      "fixture",
      { command: cmd, timeout },
      controller.signal,
      (update) => {
        if (updates === 0) initialUpdate = update.content.length === 0;
        updates++;
      },
    )
    .then(
      (result) => {
        completed = true;
        settleCount++;
        return { result };
      },
      (error) => {
        completed = true;
        settleCount++;
        return { error };
      },
    );
}

async function verifyFull(result, bytes) {
  assert.ok(result.details.fullOutputPath);
  const path = result.details.fullOutputPath;
  assert.equal(fs.statSync(path).size, bytes);
  fullHash = await hashFile(path);
  assert.equal(fullHash, observedHash.digest("hex"));
  assert.ok(result.details.truncation.truncated);
  assert.ok(result.details.truncation.outputBytes <= prefixLimit);
  assert.ok(initialUpdate);
  assert.ok(updates > 1);
  assert.ok(
    sinks.every((stream) => {
      return stream.closed && stream.writableFinished;
    }),
  );
  await rm(path);
}

async function slowOutput() {
  const [, size, mode] = scenario.split("-");
  const bytes = Number(size) * 1024 * 1024;
  const outcome = await execute(await command(producer(bytes, mode)));
  assert.ifError(outcome.error);
  await verifyFull(outcome.result, bytes);
  for (const [index, tag] of [
    [0, 65],
    [1, 66],
  ]) {
    const expectedBytes =
      mode === "mixed"
        ? bytes / 2
        : (mode === "stdout" ? index === 0 : index === 1)
          ? bytes
          : 0;
    assert.equal(pipeBytes[index], expectedBytes);
    assert.equal(
      pipeHashes[index].digest("hex"),
      expectedHash(expectedBytes, tag),
    );
  }
  producerPeaks = JSON.parse(
    await readFile(join(root, "producer-peaks.json"), "utf8"),
  );
  assert.equal(producerPeaks.length, 2);
  assert.ok(
    producerPeaks.every((peak) => {
      return peak <= 2 * chunkSize;
    }),
  );
  assert.ok(maxChunk <= chunkSize);
  assert.ok(
    peakPending <= spoolHighWaterMark + chunkSize,
    `Writable pending ${peakPending} exceeds ${spoolHighWaterMark + chunkSize}`,
  );
  assert.ok(
    peakCombined <= combinedBound,
    `${peakCombined} exceeds ${combinedBound}`,
  );
  assert.equal(maxDrainListeners, 1);
}

async function exitWhilePaused() {
  const bytes = 2 * chunkSize;
  const task = execute(await command(producer(bytes, "stdout")));
  await blocked.promise;
  await childExited.promise;
  // This delay is the behavior under test: exceed the upstream 100 ms grace
  // while the real child has exited and the disk writer is deliberately held.
  await delay(250);
  assert.equal(completed, false);
  assert.ok(acceptedBytes < bytes || children[0].stdout.readableLength > 0);
  releaseWrite();
  const outcome = await task;
  assert.ifError(outcome.error);
  await verifyFull(outcome.result, bytes);
}

async function settleWithin(promise) {
  let deadline;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        deadline = setTimeout(() => {
          return reject(
            new Error("Operation did not settle within two seconds"),
          );
        }, 2000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

async function interrupted() {
  const flushing = scenario.startsWith("flush-");
  // Line truncation creates a sub-HWM spool, so the command exits and reaches
  // stream.end() while the filesystem write is still held.
  const source = flushing
    ? 'process.stdout.write("x\\n".repeat(3000))'
    : producer(32 * 1024 * 1024, "mixed");
  const task = execute(
    await command(source),
    scenario.includes("timeout") ? 0.5 : undefined,
  );
  const stream = await blocked.promise;
  if (flushing) {
    await childExited.promise;
    while (!stream.writableEnded && !completed) await delay(1);
    assert.ok(stream.writableEnded);
  }
  if (scenario === "drain-abort") {
    stream.once("drain", () => {
      return controller.abort();
    });
    releaseWrite();
  } else if (scenario.includes("abort")) controller.abort();
  if (scenario.endsWith("write-error")) releaseWrite();
  if (scenario === "premature-close") {
    // Destroy the actual WriteStream while a real filesystem write is in flight.
    stream.destroy();
    releaseWrite();
  }
  const outcome = await settleWithin(task);
  assert.ok(outcome.error instanceof Error);
  const message = scenario.includes("abort")
    ? "Command aborted"
    : scenario.includes("timeout")
      ? "Command timed out"
      : scenario.endsWith("write-error")
        ? "controlled asynchronous disk write failure"
        : "Output file closed before";
  assert.ok(
    outcome.error.message.includes(message) ||
      (scenario === "premature-close" &&
        outcome.error.code === "ERR_STREAM_DESTROYED"),
    outcome.error.message,
  );
  assert.equal(settleCount, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  releaseWrite();
  for (const sink of sinks) {
    if (!sink.closed)
      await new Promise((resolve) => {
        return sink.once("close", resolve);
      });
    assert.equal(sink.listenerCount("drain"), 0);
    assert.equal(sink.listenerCount("finish"), 0);
    assert.equal(sink.listenerCount("error"), 0);
  }
}

async function semantics() {
  const cases = [
    { source: "", expected: "(no output)" },
    { source: 'process.stdout.write("hello\\n")', expected: "hello\n" },
    {
      source:
        'for (const byte of Buffer.from("🙂tail")) { process.stdout.write(Buffer.from([byte])); await new Promise(r => setTimeout(r, 5)); }',
      expected: "🙂tail",
    },
    {
      source: `process.stdout.write('a'.repeat(${prefixLimit}))`,
      expected: "a".repeat(prefixLimit),
    },
    {
      source:
        'process.stdout.write("p".repeat(16384)); await new Promise(r => setTimeout(r, 10)); process.stdout.write("q".repeat(65536)); process.stdout.write("tail")',
      full: "p".repeat(16384) + "q".repeat(65536) + "tail",
      truncatedBy: "bytes",
    },
    {
      source: 'process.stdout.write("x\\n".repeat(3000))',
      full: "x\n".repeat(3000),
      truncatedBy: "lines",
    },
  ];
  for (const testCase of cases) {
    const outcome = await execute(await command(testCase.source));
    assert.ifError(outcome.error);
    if (testCase.expected !== undefined) {
      assert.equal(outcome.result.content[0].text, testCase.expected);
      assert.equal(outcome.result.details, undefined);
    } else {
      const full = await readFile(
        outcome.result.details.fullOutputPath,
        "utf8",
      );
      assert.equal(full, testCase.full);
      const truncation = outcome.result.details.truncation;
      assert.equal(truncation.truncatedBy, testCase.truncatedBy);
      assert.equal(truncation.totalBytes, Buffer.byteLength(full));
      assert.equal(
        truncation.lastLinePartial,
        testCase.truncatedBy === "bytes",
      );
      await rm(outcome.result.details.fullOutputPath);
    }
  }
}

async function accumulatorLifecycle() {
  const dist = dirname(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
  );
  const { OutputAccumulator } = await import(
    join(dist, "core/tools/output-accumulator.js")
  );
  for (const persist of [true, false]) {
    const output = new OutputAccumulator({
      maxBytes: 4,
      tempFilePrefix: "pi-bash",
    });
    const raw = Buffer.from([97, 98, 99, 240]);
    output.append(raw);
    assert.equal(output.snapshot().fullOutputPath, undefined);
    output.finish({ persist });
    const snapshot = output.snapshot({ persistIfTruncated: true });
    assert.ok(snapshot.truncation.truncated);
    assert.equal(snapshot.truncation.totalBytes, 6);
    await output.waitForDrain(controller.signal);
    await output.closeTempFile(controller.signal);
    await output.closeTempFile(controller.signal);
    assert.deepEqual(await readFile(snapshot.fullOutputPath), raw);
    output.destroyTempFile();
    await rm(snapshot.fullOutputPath);
  }
}

async function compatibility() {
  const local = createLocalBashOperations();
  const chunks = [];
  const result = await local.exec("printf synchronous", root, {
    onData: (data) => {
      return chunks.push(data);
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.concat(chunks).toString(), "synchronous");
  const dist = dirname(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
  );
  const { executeBashWithOperations } = await import(
    join(dist, "core/bash-executor.js")
  );
  const interactive = await executeBashWithOperations(
    "printf '\\033[31mhello\\033[0m'",
    root,
    local,
  );
  assert.equal(interactive.output, "hello");
  assert.equal(interactive.exitCode, 0);
  const { execCommand } = await import(join(dist, "core/exec.js"));
  assert.deepEqual(
    await execCommand(
      process.execPath,
      ["-e", 'process.stdout.write("out"); process.stderr.write("err")'],
      root,
    ),
    { stdout: "out", stderr: "err", code: 0, killed: false },
  );
  const failed = await execute("printf failure; exit 7");
  assert.ifError(failed.error);
  assert.equal(failed.result.isError, true);
  assert.match(
    failed.result.content[0].text,
    /failure[\s\S]*Command exited with code 7/,
  );
  assert.equal(failed.result.structuredContent.output, "failure");
  assert.equal(failed.result.structuredContent.exit_code, 7);
}

async function quietDescendant() {
  const pidFile = join(root, "descendant.pid");
  const cmd = await command(
    `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: ['ignore', 1, 2]}); writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.unref();`,
  );
  const outcome = await settleWithin(execute(cmd));
  const pid = Number(await readFile(pidFile, "utf8"));
  process.kill(pid, "SIGKILL");
  assert.ifError(outcome.error);
  assert.equal(outcome.result.content[0].text, "(no output)");
}

function stopChildGroup(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    assert.equal(error.code, "ESRCH");
  }
}

try {
  if (scenario.startsWith("slow-")) await slowOutput();
  else if (scenario === "exit") await exitWhilePaused();
  else if (scenario === "semantics") await semantics();
  else if (scenario === "accumulator") await accumulatorLifecycle();
  else if (scenario === "compatibility") await compatibility();
  else if (scenario === "quiet") await quietDescendant();
  else if (scenario === "spawn-error") {
    const shellPath = join(root, "broken-shell");
    await writeFile(shellPath, "#!/missing-interpreter\n", { mode: 0o755 });
    await assert.rejects(
      createBashTool(root, { shellPath }).execute(
        "fixture",
        { command: "echo impossible" },
        controller.signal,
      ),
      /ENOENT/,
    );
  } else if (scenario === "open-error") {
    const outcome = await execute(
      await command(producer(32 * 1024 * 1024, "mixed")),
    );
    assert.match(outcome.error.message, /ENOENT/);
  } else await interrupted();
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  for (const child of children) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        return child.once("exit", resolve);
      });
    }
    assert.equal(child.listenerCount("error"), 0);
    assert.equal(child.listenerCount("close"), 0);
    assert.equal(child.stdout.listenerCount("resume"), 0);
    assert.equal(child.stderr.listenerCount("resume"), 0);
    // execCommand keeps its original collection listeners; the local Bash
    // producer must leave only the fixture's hash observers.
    const dataListeners =
      scenario === "compatibility" && child.spawnfile === process.execPath
        ? 2
        : 1;
    assert.equal(child.stdout.listenerCount("data"), dataListeners);
    assert.equal(child.stderr.listenerCount("data"), dataListeners);
  }
  assert.ifError(failure);
  process.stdout.write(
    JSON.stringify({
      scenario,
      peakPending,
      peakReads,
      peakCombined,
      combinedBound,
      maxChunk,
      fullHash,
      producerPeaks,
      maxDrainListeners,
      settleCount,
    }) + "\n",
  );
} finally {
  clearTimeout(watchdog);
  clearInterval(sampler);
  controller.abort();
  releaseWrite();
  fs.createWriteStream = realCreateWriteStream;
  childProcess.spawn = realSpawn;
  syncBuiltinESMExports();
  for (const child of children) stopChildGroup(child);
  for (const sink of sinks) {
    sink.destroy();
    await rm(sink.path, { force: true });
  }
  await rm(root, { recursive: true, force: true });
}
