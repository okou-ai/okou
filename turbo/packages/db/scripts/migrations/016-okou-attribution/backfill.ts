import { appendFile, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  fingerprint,
  inventoryFingerprint,
  parseInventory,
  plan,
  snapshotKey,
  type Inventory,
  type Snapshot,
  type Source,
} from "./model";
import { Provider } from "./providers";
import { databaseIdentity, scanDatabase } from "./database";

function integer(value: string | undefined, fallback: number, max: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed > max) {
    throw new Error("Invalid numeric option");
  }
  return parsed;
}

async function stableScan(
  source: Source,
  cutoff: number,
  interval: number,
  signal: AbortSignal,
) {
  const provider =
    source === "database" ? undefined : new Provider(source, interval);
  const identity = provider
    ? await provider.identity(signal)
    : databaseIdentity();
  const scan = async () => {
    return provider
      ? await provider.scan(cutoff, signal)
      : await scanDatabase(cutoff, signal);
  };
  const first = await scan();
  const second = await scan();
  if (inventoryFingerprint(first) !== inventoryFingerprint(second)) {
    throw new Error(
      "Source changed across full scans; no complete inventory was produced",
    );
  }
  const afterIdentity = provider
    ? await provider.identity(signal)
    : databaseIdentity();
  if (afterIdentity !== identity)
    throw new Error("Source identity changed during inventory");
  return parseInventory({
    version: 1,
    source,
    identity,
    cutoff,
    records: second,
  });
}

function summary(inventory: Inventory) {
  const resources: Record<string, number> = {};
  let candidates = 0;
  let additions = 0;
  let conflicts = 0;
  for (const record of inventory.records) {
    resources[record.resource] = (resources[record.resource] ?? 0) + 1;
    const change = plan(record);
    if (change.additions) candidates++;
    additions += change.additions;
    if (change.problems.length) conflicts++;
  }
  return {
    resources,
    records: inventory.records.length,
    candidates,
    additions,
    conflicts,
  };
}

async function verify(
  inventory: Inventory,
  interval: number,
  signal: AbortSignal,
) {
  const current = await stableScan(
    inventory.source,
    inventory.cutoff,
    interval,
    signal,
  );
  if (current.identity !== inventory.identity)
    throw new Error("Source identity does not match the inventory");
  const expected = inventory.records.map((record): Snapshot => {
    return { ...record, value: plan(record).after };
  });
  const matches =
    inventoryFingerprint(expected) === inventoryFingerprint(current.records);
  const counts = summary(current);
  return {
    mode: "verify",
    ...counts,
    matches,
    complete: matches && counts.conflicts === 0 && counts.candidates === 0,
  };
}

async function migrate(
  inventory: Inventory,
  args: { offset: number; limit: number; interval: number; journal: string },
  signal: AbortSignal,
) {
  if (inventory.source === "database")
    throw new Error(
      "Database attribution is read-only; no schema or data rewrite is needed",
    );
  const provider = new Provider(inventory.source, args.interval);
  if ((await provider.identity(signal)) !== inventory.identity)
    throw new Error("Source identity does not match the inventory");
  const selected = inventory.records.slice(
    args.offset,
    args.offset + args.limit,
  );
  let applied = 0;
  let unchanged = 0;
  for (const record of selected) {
    signal.throwIfAborted();
    const change = plan(record);
    if (change.problems.length)
      throw new Error(
        "Inventory contains ambiguous or malformed attribution; resolve the restricted report first",
      );
    const current = await provider.read(record, signal);
    if (fingerprint(current.value) === fingerprint(change.after)) {
      unchanged++;
      continue;
    }
    if (fingerprint(current.value) !== fingerprint(record.value)) {
      throw new Error(
        "Source drifted since inventory; no stale value was written",
      );
    }
    const journalEntry = {
      record: snapshotKey(record),
      before: fingerprint(record.value),
      after: fingerprint(change.after),
    };
    await appendFile(
      args.journal,
      `${JSON.stringify({ ...journalEntry, status: "pending" })}\n`,
      { mode: 0o600 },
    );
    await provider.write(record, change.patch, signal);
    const readback = await provider.read(record, signal);
    if (fingerprint(readback.value) !== fingerprint(change.after)) {
      throw new Error(
        "Post-write reconciliation failed; stop writers and inspect the restricted inventory and journal",
      );
    }
    await appendFile(
      args.journal,
      `${JSON.stringify({ ...journalEntry, status: "verified" })}\n`,
      { mode: 0o600 },
    );
    applied++;
  }
  return {
    mode: "migrate",
    applied,
    unchanged,
    nextOffset: args.offset + selected.length,
    batchComplete: args.offset + selected.length === inventory.records.length,
  };
}

export async function runBackfill(argv: string[], signal: AbortSignal) {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: "string" },
      output: { type: "string" },
      plan: { type: "string" },
      identity: { type: "string" },
      cutoff: { type: "string" },
      offset: { type: "string" },
      limit: { type: "string" },
      "interval-ms": { type: "string" },
      migrate: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      "writers-quiesced": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const interval = integer(values["interval-ms"], 500, 60_000);
  if (values.migrate || values.verify) {
    if (values.migrate && values.verify)
      throw new Error("Select migrate or verify");
    if (values.source || values.output || values.cutoff) {
      throw new Error(
        "Source and cutoff come from the saved plan; do not combine inventory options with migrate or verify",
      );
    }
    if (!values.plan) throw new Error("A saved --plan is required");
    const inventory = parseInventory(
      JSON.parse(await readFile(values.plan, "utf8")),
    );
    if (values.verify) return await verify(inventory, interval, signal);
    if (!values["writers-quiesced"] || values.identity !== inventory.identity) {
      throw new Error(
        "Migration requires --writers-quiesced and --identity matching the reviewed plan; providers offer no compare-and-set",
      );
    }
    // Refuse partial success when the reviewed source has unresolved exceptions.
    if (summary(inventory).conflicts > 0)
      throw new Error("Resolve inventory conflicts before migration");
    const limit = integer(values.limit, 100, 1000);
    if (!limit) throw new Error("Migration limit must be positive");
    const offset = integer(values.offset, 0, inventory.records.length);
    return await migrate(
      inventory,
      { offset, limit, interval, journal: `${values.plan}.journal.jsonl` },
      signal,
    );
  }
  if (
    !values.output ||
    (values.source !== "clerk" &&
      values.source !== "stripe" &&
      values.source !== "database")
  ) {
    throw new Error(
      "Dry run requires --source clerk|stripe|database and a new --output file",
    );
  }
  const cutoff = integer(
    values.cutoff,
    Math.floor(Date.now() / 1000),
    Math.floor(Date.now() / 1000),
  );
  if (!cutoff) throw new Error("Cutoff must be positive");
  const inventory = await stableScan(values.source, cutoff, interval, signal);
  await writeFile(values.output, `${JSON.stringify(inventory, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    `${values.output}.exceptions.json`,
    `${JSON.stringify(
      inventory.records.flatMap((record) => {
        const problems = plan(record).problems;
        return problems.length
          ? [{ record: snapshotKey(record), problems }]
          : [];
      }),
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return {
    mode: "dry-run",
    ...summary(inventory),
    digest: inventoryFingerprint(inventory.records),
  };
}

if (import.meta.main) {
  const controller = new AbortController();
  const abort = () => {
    return controller.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result = await runBackfill(process.argv.slice(2), controller.signal);
    console.log(JSON.stringify(result));
    if ("complete" in result && !result.complete) process.exitCode = 1;
    if ("conflicts" in result && result.conflicts > 0) process.exitCode = 1;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Attribution migration failed",
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
