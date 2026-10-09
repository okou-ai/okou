import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { TSESLint } from "@typescript-eslint/utils";
import { afterEach, expect, test } from "vitest";

import {
  createTransactionBaseline,
  legacyTransactionComment,
  transactionBaselinePath,
} from "../transaction-policy.ts";
import { scanTransactionSources } from "../transaction-scan.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const codeFile = "turbo/apps/api/src/example.ts";
const legacyCode =
  "export async function example() {\n  await db.transaction(async tx => tx.insert(items));\n}\n";
const checker = fileURLToPath(
  new URL("../../../../../scripts/check-db-transactions.mts", import.meta.url),
);
const loader = import.meta.resolve("tsx");

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "transaction-policy-"));
  roots.push(root);
  function write(file: string, code: string): void {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), code);
  }
  function git(args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" });
  }
  git(["init", "-q"]);
  git(["config", "user.email", "transaction-policy@example.test"]);
  git(["config", "user.name", "Transaction policy test"]);
  const scanned = await scanTransactionSources(
    [{ file: codeFile, code: legacyCode }],
    root,
  );
  const baseline = createTransactionBaseline(scanned.map(({ site }) => site));
  const marked = legacyCode.replace(
    "  await",
    `  ${legacyTransactionComment("TX-0001")}\n  await`,
  );
  write(codeFile, marked);
  write(transactionBaselinePath, JSON.stringify(baseline));
  git(["add", "."]);
  git(["commit", "-qm", "initial frozen inventory"]);
  const base = git(["rev-parse", "HEAD"]).trim();
  function check() {
    return spawnSync(process.execPath, ["--import", loader, checker, base], {
      cwd: root,
      encoding: "utf8",
    });
  }
  return { root, write, git, check, baseline, marked };
}

test("the CLI accepts registered legacy transactions after formatting-only edits", async () => {
  const f = await fixture();
  f.write(
    codeFile,
    `// moved down without changing ownership\n\n${f.marked.replace("async tx => tx.insert(items)", "async (tx) => { /* unchanged */ return tx.insert(items); }")}`,
  );
  // Braces and a return statement change the AST, unlike whitespace/parentheses.
  expect(f.check().status).not.toBe(0);
  f.write(
    codeFile,
    `// moved down\n\n${f.marked.replace("async tx", "async (tx)")}`,
  );
  const result = f.check();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("1 frozen legacy sites");
});

test.each([
  {
    name: "a new transaction",
    change: (code: string) =>
      `${code}\nasync function added() { await db.transaction(work); }`,
  },
  {
    name: "a copied legacy marker",
    change: (code: string) => `${code}\n${code.replace("example", "added")}`,
  },
  {
    name: "a made-up ID",
    change: (code: string) => code.replace("TX-0001", "TX-9999"),
  },
  {
    name: "a different callback",
    change: (code: string) =>
      code.replace("tx.insert(items)", "tx.delete(items)"),
  },
  {
    name: "renamed ownership",
    change: (code: string) => code.replace("example", "added"),
  },
  {
    name: "file-wide disable",
    change: (code: string) =>
      code.replace("eslint-disable-next-line", "eslint-disable"),
  },
  {
    name: "disable-all",
    change: (code: string) =>
      code.replace(
        "eslint-disable-next-line api/no-db-transaction",
        "eslint-disable-next-line",
      ),
  },
  {
    name: "extra disabled rules",
    change: (code: string) =>
      code.replace(
        "api/no-db-transaction --",
        "api/no-db-transaction, api/db-transaction-exemptions --",
      ),
  },
])(
  "the CLI rejects $name even though inline disables exist",
  async ({ change }) => {
    const f = await fixture();
    f.write(codeFile, change(f.marked));
    expect(f.check().status).not.toBe(0);
  },
);

test.each(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"])(
  "the CLI rejects new transactions in untracked .%s source files",
  async (extension) => {
    const f = await fixture();
    f.write(
      `turbo/apps/api/scripts/added.${extension}`,
      "export const result = db.transaction(work);",
    );
    const result = f.check();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "a new database transaction requires a necessary billing exception",
    );
  },
);

test("PR edits cannot enlarge or rewrite the base/main inventory", async () => {
  const f = await fixture();
  f.write(
    transactionBaselinePath,
    JSON.stringify({
      ...f.baseline,
      sites: [{ ...f.baseline.sites[0], fingerprint: "0".repeat(64) }],
    }),
  );
  expect(f.check().stderr).toContain("deletion-only");
  f.write(
    transactionBaselinePath,
    JSON.stringify({
      ...f.baseline,
      sites: [...f.baseline.sites, { ...f.baseline.sites[0], id: "TX-0002" }],
    }),
  );
  expect(f.check().stderr).toContain("deletion-only");
});

test("deletion is allowed only with its marker and inventory entry removed", async () => {
  const f = await fixture();
  f.write(codeFile, "export const result = 1;");
  expect(f.check().stderr).toContain("unused legacy inventory entry");
  f.write(
    transactionBaselinePath,
    JSON.stringify({ ...f.baseline, sites: [] }),
  );
  expect(f.check().status).toBe(0);
});

test("a legacy ID deleted from main cannot be resurrected", async () => {
  const f = await fixture();
  f.write(codeFile, "export const result = 1;");
  f.write(
    transactionBaselinePath,
    JSON.stringify({ ...f.baseline, sites: [] }),
  );
  f.git(["add", "."]);
  f.git(["commit", "-qm", "remove legacy transaction"]);
  const newBase = f.git(["rev-parse", "HEAD"]).trim();
  f.write(codeFile, f.marked);
  f.write(transactionBaselinePath, JSON.stringify(f.baseline));
  const result = spawnSync(
    process.execPath,
    ["--import", loader, checker, newBase],
    { cwd: f.root, encoding: "utf8" },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("deletion-only");
});

test("a necessary billing reason is separate from the frozen legacy registry", async () => {
  const f = await fixture();
  f.write(
    codeFile,
    "export async function settle() {\n// eslint-disable-next-line api/no-db-transaction -- Billing atomicity: ledger debit and wallet update must commit together; single-statement alternative: the two writes require independent invariant checks.\nawait db.transaction(work);\n}",
  );
  f.write(
    transactionBaselinePath,
    JSON.stringify({ ...f.baseline, sites: [] }),
  );
  const result = f.check();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("1 billing exceptions");
  f.write(
    codeFile,
    "// eslint-disable-next-line api/no-db-transaction -- billing\nawait db.transaction(work);",
  );
  expect(f.check().status).not.toBe(0);
});

test("suppression cannot hide the exemption validator from the CI scan", async () => {
  const f = await fixture();
  f.write(
    codeFile,
    `/* eslint-disable api/db-transaction-exemptions */\n${f.marked.replace("eslint-disable-next-line", "eslint-disable")}`,
  );
  expect(f.check().status).not.toBe(0);
});

test("moving a legacy transaction to another file is not grandfathered", async () => {
  const f = await fixture();
  f.write(codeFile, "export const result = 1;");
  f.write("turbo/apps/api/scripts/moved.ts", f.marked);
  expect(f.check().stderr).toContain("moved, or changed");
});

test("standalone SQL uses a next-line SQL comment and does not confuse quoted directives", async () => {
  const root = mkdtempSync(join(tmpdir(), "transaction-sql-"));
  roots.push(root);
  const file = "turbo/packages/db/scripts/example.sql";
  const code =
    "-- eslint-disable-next-line api/no-db-transaction -- Billing atomicity: wallet and ledger must commit together; single-statement alternative: independent checks are required.\nBEGIN;\nUPDATE wallet SET balance = 1; COMMIT;";
  for (const newline of ["\n", "\r\n", "\r"]) {
    const result = await scanTransactionSources(
      [{ file, code: code.replaceAll("\n", newline) }],
      root,
    );
    expect(result).toHaveLength(1);
    expect(result[0].site.line).toBe(2);
    expect(result[0].exemption?.kind).toBe("billing");
  }
  expect(
    await scanTransactionSources(
      [
        {
          file,
          code: "DO $$ BEGIN\n-- eslint-disable-next-line api/no-db-transaction\nPERFORM 1; END $$;",
        },
      ],
      root,
    ),
  ).toEqual([]);
});

test.each([
  {
    cwd: new URL("../../../../../apps/api/", import.meta.url),
    file: "src/signals/services/billing-new.service.ts",
  },
  {
    cwd: new URL("../../../../../apps/api/", import.meta.url),
    file: "src/signals/routes/__tests__/new-transaction.test.ts",
  },
  {
    cwd: new URL("../../../../../apps/api/", import.meta.url),
    file: "scripts/new-transaction.ts",
  },
  {
    cwd: new URL("../../../../db/", import.meta.url),
    file: "scripts/new-transaction.ts",
  },
  {
    cwd: new URL("../../../../db/", import.meta.url),
    file: "src/migrations/9999_new_transaction.sql",
  },
  ...["mts", "cts", "jsx"].flatMap((extension) => {
    return [
      {
        cwd: new URL("../../../../../apps/api/", import.meta.url),
        file: `scripts/new-transaction.${extension}`,
      },
      {
        cwd: new URL("../../../../db/", import.meta.url),
        file: `scripts/new-transaction.${extension}`,
      },
    ];
  }),
])(
  "the real package config rejects transactions in $file",
  async ({ cwd, file }) => {
    const eslint = new TSESLint.FlatESLint({ cwd: fileURLToPath(cwd) });
    const [result] = await eslint.lintText(
      file.endsWith(".sql")
        ? "BEGIN; SELECT 1; COMMIT;"
        : "export const result = db.transaction(work);",
      { filePath: file },
    );
    expect(result.messages).toContainEqual(
      expect.objectContaining({ ruleId: "api/no-db-transaction", severity: 2 }),
    );
  },
);
