import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createTransactionBaseline,
  parseTransactionBaseline,
  transactionBaselinePath,
  transactionBootstrapCommit,
  transactionSourceRoots,
  validateTransactionBaseline,
  validateTransactionSites,
  type TransactionBaseline,
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
let base: TransactionBaseline;
if (existsAt(baseRevision, transactionBaselinePath)) {
  base = parseTransactionBaseline(
    JSON.parse(git(["show", `${baseRevision}:${transactionBaselinePath}`])),
  );
} else {
  if (existsAt(baseRevision, "turbo/scripts/check-db-transactions.mts"))
    throw new Error(
      "The enforced base/main inventory is missing; bootstrap cannot be reused after activation.",
    );
  git(["cat-file", "-e", `${transactionBootstrapCommit}^{commit}`]);
  const files = sourceFiles(
    git([
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      transactionBootstrapCommit,
      "--",
      ...transactionSourceRoots,
    ]),
  );
  const original = await scanTransactionSources(
    files.map((file) => {
      return {
        file,
        code: git(["show", `${transactionBootstrapCommit}:${file}`]),
      };
    }),
    repo,
  );
  base = createTransactionBaseline(
    original.map(({ site }) => {
      return site;
    }),
  );
}
validateTransactionBaseline(current, base);
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
  `Database transaction policy passed: ${current.sites.length} frozen legacy sites, ${
    scanned.filter(({ exemption }) => {
      return exemption?.kind === "billing";
    }).length
  } billing exceptions; base ${baseRevision}.`,
);
