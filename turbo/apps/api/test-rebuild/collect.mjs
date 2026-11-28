import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { createVitest } from "vitest/node";
import process from "node:process";

const repo = resolve(import.meta.dirname, "../../../..");
const root = resolve(repo, "turbo");
const git = (...args) => {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
};
const output = process.argv[2];

if (!output) {
  throw new Error("Usage: node collect.mjs <output.json>");
}
if (!process.env.DATABASE_URL) {
  throw new Error(
    "Set DATABASE_URL to a migrated, disposable local PostgreSQL database.",
  );
}

const baseline = git("rev-parse", "HEAD");
const trackedFiles = new Set(
  git("ls-tree", "-r", "--name-only", baseline, "--", "turbo/apps/api").split(
    "\n",
  ),
);

process.env.VITEST = "true";
process.env.NODE_ENV ??= "test";

const vitest = await createVitest({
  root,
  run: true,
  watch: false,
  project: ["api"],
  includeTaskLocation: true,
});

try {
  const specs = await vitest.getRelevantTestSpecifications();
  const expected = new Set(
    specs.map((spec) => {
      return relative(repo, spec.moduleId);
    }),
  );
  if (!expected.size) {
    throw new Error("The API project has no test modules");
  }
  process.stdout.write(
    `Collecting ${expected.size} Vitest modules at ${baseline}\n`,
  );
  const { testModules, unhandledErrors } = await vitest.collect([], {
    staticParse: false,
  });
  if (unhandledErrors.length) {
    throw new AggregateError(unhandledErrors, "Vitest collection failed");
  }

  const files = testModules
    .map((module) => {
      const file = relative(repo, module.moduleId);
      if (!trackedFiles.has(file) || !expected.delete(file)) {
        throw new Error(`Unexpected or duplicate module: ${file}`);
      }
      // Vitest normalizes focused tasks to run/skip before reporting. Fail
      // closed if a later snapshot needs to capture the pre-normalized modes.
      if (module.task.containsOnly) {
        throw new Error(
          `Focused tasks require pre-normalization metadata: ${file}`,
        );
      }
      const suites = [module, ...module.children.allSuites()];
      const errors = suites.flatMap((suite) => {
        return suite.errors();
      });
      if (errors.length) {
        throw new AggregateError(errors, `Could not collect ${file}`);
      }

      const stem = basename(file).replace(/\.(test|spec)\.[^.]+$/u, "");
      if (stem === basename(file)) {
        throw new Error(`No test suffix: ${file}`);
      }
      const cases = [...module.children.allTests()].map((test, index) => {
        if (!["run", "skip", "todo", "only"].includes(test.task.mode)) {
          throw new Error(`Unexpected mode: ${file} > ${test.fullName}`);
        }
        return {
          id: `${stem}-${String(index + 1).padStart(3, "0")}`,
          name: test.fullName,
          mode: test.task.mode,
          location: test.location ?? null,
        };
      });
      if (!cases.length) {
        throw new Error(`No cases collected from ${file}`);
      }
      return { file, cases };
    })
    .sort((a, b) => {
      return a.file.localeCompare(b.file, "en");
    });
  if (expected.size || process.exitCode) {
    throw new Error(
      `Incomplete collection. Missing modules: ${[...expected].join(", ")}`,
    );
  }

  if (git("rev-parse", "HEAD") !== baseline) {
    throw new Error("The checkout changed during collection");
  }
  const excludedNodeTests = [...trackedFiles].filter((file) => {
    return /^turbo\/apps\/api\/scripts\/[^/]+\.node-test\.mjs$/u.test(file);
  });
  writeFileSync(
    output,
    JSON.stringify({ baseline, excludedNodeTests, files }, null, 2) + "\n",
    { flag: "wx" },
  );
  process.stdout.write(`Collected ${files.length} modules\n`);
} finally {
  await vitest.close();
}
