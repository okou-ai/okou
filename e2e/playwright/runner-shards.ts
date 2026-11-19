import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const MAX_SHARDS = 12;
const BASE_JOB_MINUTES = 15;
// Allow a live case to spend its full 600-second budget on both attempts.
const LIVE_CASE_JOB_MINUTES = 20;

interface WeightedTestFile {
  readonly path: string;
  readonly weight: number;
  readonly retries: boolean;
}

interface RunnerShard {
  readonly files: string[];
  readonly index: number;
  weight: number;
  timeoutMinutes: number;
}

async function main(): Promise<void> {
  const testDirectory = resolve(process.argv[2] ?? "tests/03-runner");
  const files = await discoverTestFiles(testDirectory);
  const matrix = buildMatrix(files);
  process.stdout.write(`${JSON.stringify(matrix)}\n`);
}

async function discoverTestFiles(
  testDirectory: string,
): Promise<readonly WeightedTestFile[]> {
  const entries = await readdir(testDirectory, { withFileTypes: true });
  const batsFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".bats"))
    .map((entry) => resolve(testDirectory, entry.name))
    .sort();

  if (batsFiles.length === 0) {
    throw new Error(`No runner E2E test files found in ${testDirectory}`);
  }

  return await Promise.all(
    batsFiles.map(async (filePath) => {
      const source = await readFile(filePath, "utf8");
      const weight = source.match(/^\s*@test\b/gmu)?.length ?? 0;
      if (weight === 0) {
        throw new Error(`Runner E2E test file has no tests: ${filePath}`);
      }
      return {
        path: relative(process.cwd(), filePath).split(sep).join("/"),
        weight,
        retries: /^BATS_TEST_RETRIES=1$/mu.test(source),
      };
    }),
  );
}

function buildMatrix(files: readonly WeightedTestFile[]): {
  readonly include: readonly RunnerShard[];
} {
  const shardCount = Math.min(MAX_SHARDS, files.length);
  const shards: RunnerShard[] = Array.from(
    { length: shardCount },
    (_, index) => ({
      files: [],
      index: index + 1,
      weight: 0,
      timeoutMinutes: BASE_JOB_MINUTES,
    }),
  );
  const orderedFiles = [...files].sort((left, right) => {
    if (left.weight !== right.weight) {
      return right.weight - left.weight;
    }
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });

  for (const file of orderedFiles) {
    const shard = shards.reduce((lightest, candidate) => {
      if (candidate.weight !== lightest.weight) {
        return candidate.weight < lightest.weight ? candidate : lightest;
      }
      return candidate.index < lightest.index ? candidate : lightest;
    });
    shard.files.push(file.path);
    shard.weight += file.weight;
    if (file.retries) {
      shard.timeoutMinutes += LIVE_CASE_JOB_MINUTES;
    }
  }

  for (const shard of shards) {
    shard.files.sort();
  }

  // Keep the independent probes in the same shard for the one-off overlap check.
  const strapiFile = "tests/03-runner/run-t03-firewall-strapi.bats";
  const customFile = "tests/03-runner/run-t23-custom-connector.bats";
  const strapiShard = shards.find((shard) => shard.files.includes(strapiFile));
  const customShard = shards.find((shard) => shard.files.includes(customFile));
  if (strapiShard && customShard && strapiShard !== customShard) {
    strapiShard.files.splice(strapiShard.files.indexOf(strapiFile), 1);
    customShard.files.unshift(strapiFile);
    strapiShard.weight -= 1;
    customShard.weight += 1;
  }

  return { include: shards };
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
