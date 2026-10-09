import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  parseTransactionBaseline,
  transactionBaselinePath,
  transactionSourceRoots,
  validateTransactionBaseline,
  validateTransactionSites,
} from "../packages/eslint-rules/src/api/transaction-policy.ts";
import { scanTransactionSources } from "../packages/eslint-rules/src/api/transaction-scan.ts";

const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}
function existsAt(revision: string, file: string): boolean {
  return git(["ls-tree", "--name-only", revision, "--", file]).trim() === file;
}
function sourceFiles(list: string): string[] {
  return [
    ...new Set(
      list.split("\0").filter((file) => {
        return (
          /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|sql)$/u.test(file) &&
          !/\.d\.(?:ts|mts|cts)$/u.test(file)
        );
      }),
    ),
  ].sort();
}

const [baseRevision, ...extra] = process.argv.slice(2);
if (!baseRevision || extra.length || !/^[a-f0-9]{40}$/u.test(baseRevision))
  throw new Error(
    "Usage: tsx scripts/check-db-transactions.mts <full-base-main-sha>",
  );
git(["cat-file", "-e", `${baseRevision}^{commit}`]);
const current = parseTransactionBaseline(
  JSON.parse(readFileSync(resolve(repo, transactionBaselinePath), "utf8")),
);
if (existsAt(baseRevision, transactionBaselinePath)) {
  const base = parseTransactionBaseline(
    JSON.parse(git(["show", `${baseRevision}:${transactionBaselinePath}`])),
  );
  validateTransactionBaseline(current, base);
} else {
  if (existsAt(baseRevision, "turbo/scripts/check-db-transactions.mts"))
    throw new Error(
      "The enforced base/main inventory is missing; bootstrap cannot be reused after activation.",
    );
  const files = sourceFiles(
    git([
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      baseRevision,
      "--",
      ...transactionSourceRoots,
    ]),
  );
  const original = await scanTransactionSources(
    files.map((file) => {
      return {
        file,
        code: git(["show", `${baseRevision}:${file}`]),
      };
    }),
    repo,
  );
  // Activation registers existing boundaries by file and owner, without
  // freezing callback bodies or pinning a particular main revision.
  const available = new Map<string, number>();
  for (const { site } of original) {
    const key = JSON.stringify([site.file, site.owner]);
    available.set(key, (available.get(key) ?? 0) + 1);
  }
  for (const site of current.sites) {
    const key = JSON.stringify([site.file, site.owner]);
    const remaining = available.get(key) ?? 0;
    if (!remaining)
      throw new Error(
        `${site.id}: initial legacy inventory exceeds the existing transaction boundaries in base/main for ${site.file} (${site.owner}).`,
      );
    available.set(key, remaining - 1);
  }
}
const files = sourceFiles(
  git([
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...transactionSourceRoots,
  ]),
);
const scanned = await scanTransactionSources(
  files.map((file) => {
    return { file, code: readFileSync(resolve(repo, file), "utf8") };
  }),
  repo,
);
validateTransactionSites(scanned, current);
console.log(
  `Database transaction policy passed: ${current.sites.length} legacy sites, ${
    scanned.filter(({ exemption }) => {
      return exemption?.kind === "billing";
    }).length
  } billing exceptions; base ${baseRevision}.`,
);
