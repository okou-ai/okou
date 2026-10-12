import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noDbTransaction } from "../rules/no-db-transaction.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester();

tester.run("no-db-transaction", noDbTransaction, {
  valid: [
    "const transaction = { amount: 10 }; receipt.transaction = transaction;",
    "const { transaction } = receipt; JSON.stringify(transaction);",
    "const amount = payment.transaction.amount;",
    "const value = receipt['BEGIN']; const record = { BEGIN: 1, 'BEGIN': 2 };",
    "type Tx = Parameters<Db['transaction']>[0];",
    "const sql = `SELECT 'BEGIN', transaction FROM ledger`;",
    "const sql = `DO $$ BEGIN PERFORM 1; END $$;`;",
    "const sql = `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;`;",
    "const sql = `SELECT 1 /* ; BEGIN; */; -- START TRANSACTION`;",
    "client.query('COMMIT'); client.query('ROLLBACK');",
    "const sql = `SELECT ${'BEGIN'}`;",
  ],
  invalid: [
    ...[
      "db.transaction(async (tx) => tx.insert(items));",
      "tx.transaction(async (nested) => nested.update(items));",
      "database['transaction'](work);",
      "database['trans' + 'action'](work);",
      "db?.transaction?.(work);",
      "db.transaction().execute(work);",
      "sql.begin(work);",
      "sql['begin'](work);",
      "sql.savepoint(work);",
      "const open = handle.transaction; open(work);",
      "const open = handle.transaction; const alias = open; alias(work);",
      "const open = handle.transaction.bind(handle); open(work);",
      "handle.transaction.call(handle, work);",
      "const { transaction: open } = handle; open(work);",
      "const { transaction: open = fallback } = handle; open(work);",
      "function exportedTransaction() { return get(db$).transaction; }",
      "const wrapper = { open: set(writeDb$).transaction };",
      "function withTransaction(work) { return db.transaction(work); }",
      "client.query('BEGIN');",
      "client.query('START TRANSACTION READ ONLY');",
      "client.query('SAVEPOINT nested');",
      "client.query('BEGIN; invalid query here');",
      "client.query('START /* nested /* comment */ ok */ TRANSACTION');",
      "client.query('BE' + 'GIN');",
      "client.query(`${'BE'}${'GIN'}`);",
      "client.query(`BEGIN; SELECT ${id}`);",
    ].map((code) => ({
      code,
      errors: [{ messageId: "transaction" as const }],
    })),
    {
      code: "db.transaction(async tx => tx.transaction(work));",
      errors: [{ messageId: "transaction" }, { messageId: "transaction" }],
    },
  ],
});
