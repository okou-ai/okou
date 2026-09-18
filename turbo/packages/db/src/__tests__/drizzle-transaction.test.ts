import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool, type PoolClient } from "pg";
import { describe, expect, it, type TestContext } from "vitest";

const { drizzle: drizzleCommonJs }: typeof import("drizzle-orm/node-postgres") =
  createRequire(import.meta.url)("drizzle-orm/node-postgres");

// Infrastructure-only exception: an API caller cannot cause a disconnect at
// BEGIN or a failed ROLLBACK. This wire fixture faults the database boundary;
// installed Drizzle and pg still own transactions, protocol parsing and pooling.
interface Faults {
  startup?: boolean;
  begin?: "reject" | "disconnect";
  commit?: boolean;
  rollback?: boolean;
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function message(type: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(type), int32(payload.length + 4), payload]);
}

function ready(state: string): Buffer {
  return message("Z", Buffer.from(state));
}

function failure(code: string, text: string): Buffer {
  return message("E", Buffer.from(`SERROR\0C${code}\0M${text}\0\0`));
}

function sessionResult(id: number): Buffer {
  // One text column, decoded by the real pg protocol parser and type registry.
  const field = Buffer.alloc(18);
  field.writeInt32BE(25, 6);
  field.writeInt16BE(-1, 10);
  field.writeInt32BE(-1, 12);
  const value = Buffer.from(String(id));
  return Buffer.concat([
    message(
      "T",
      Buffer.concat([Buffer.from([0, 1]), Buffer.from("session_id\0"), field]),
    ),
    message(
      "D",
      Buffer.concat([Buffer.from([0, 1]), int32(value.length), value]),
    ),
    message("C", Buffer.from("SELECT 1\0")),
  ]);
}

async function databaseFixture(
  createDatabase: typeof drizzle,
  faults: Faults,
  onTestFinished: TestContext["onTestFinished"],
) {
  const sockets = new Set<Socket>();
  let sessionId = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      return sockets.delete(socket);
    });
    const id = ++sessionId;
    let buffer = Buffer.alloc(0);
    let startup = true;
    let state = "I";
    function respondToQuery(query: string): void {
      if (query.startsWith("begin") && faults.begin) {
        const fault = faults.begin;
        delete faults.begin;
        if (fault === "disconnect") {
          socket.destroy();
          return;
        }
        socket.write(
          Buffer.concat([failure("08006", "BEGIN rejected"), ready(state)]),
        );
        return;
      }
      if (query === "commit" && faults.commit) {
        faults.commit = false;
        state = "E";
        socket.write(
          Buffer.concat([failure("40001", "COMMIT rejected"), ready(state)]),
        );
        return;
      }
      if (query === "rollback" && faults.rollback) {
        faults.rollback = false;
        state = "E";
        // A SQL error leaves pg queryable: discarding must be explicit.
        socket.write(
          Buffer.concat([failure("57014", "ROLLBACK rejected"), ready(state)]),
        );
        return;
      }
      if (query.startsWith("begin")) state = "T";
      if (query === "commit" || query === "rollback") state = "I";
      const result =
        query === "select session_id"
          ? sessionResult(id)
          : message(
              "C",
              Buffer.from(`${query.split(" ")[0]?.toUpperCase()}\0`),
            );
      socket.write(Buffer.concat([result, ready(state)]));
    }

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= (startup ? 4 : 5)) {
        const length = buffer.readInt32BE(startup ? 0 : 1);
        const packetLength = length + (startup ? 0 : 1);
        if (buffer.length < packetLength) return;
        const packet = buffer.subarray(0, packetLength);
        buffer = buffer.subarray(packetLength);
        if (startup) {
          startup = false;
          if (faults.startup) {
            faults.startup = false;
            socket.end(failure("08006", "startup rejected"));
            return;
          }
          socket.write(Buffer.concat([message("R", int32(0)), ready(state)]));
          continue;
        }
        const type = packet.toString("utf8", 0, 1);
        if (type === "X") {
          socket.end();
          return;
        }
        if (type !== "Q") throw new Error(`Unexpected pg message: ${type}`);
        respondToQuery(packet.toString("utf8", 5, packet.length - 1));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing pg fixture port");
  const connection = {
    host: "127.0.0.1",
    port: address.port,
    user: "transaction-test",
    database: "transaction-test",
    password: "synthetic",
    ssl: false,
    connectionTimeoutMillis: 500,
  };
  const pool = new Pool({ ...connection, max: 1, idleTimeoutMillis: 0 });
  const borrowed = new Set<PoolClient>();
  pool.on("acquire", (client) => {
    return borrowed.add(client);
  });
  pool.on("release", (_error, client) => {
    return borrowed.delete(client);
  });
  // A transport loss can also emit a client error while it rejects the query.
  pool.on("connect", (client) => {
    return client.on("error", () => {});
  });
  onTestFinished(async () => {
    // Baseline BEGIN leaks must not make teardown hang after a failed assertion.
    for (const client of borrowed) client.release(true);
    await pool.end();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        return error ? reject(error) : resolve();
      });
    });
  });
  return { database: createDatabase(pool), connection };
}

const variants = [
  { name: "ESM", createDatabase: drizzle },
  { name: "CJS", createDatabase: drizzleCommonJs },
];

describe.each(variants)(
  "$name node-postgres transaction cleanup",
  ({ createDatabase }) => {
    it("recovers after connection acquisition fails without entering the callback", async ({
      onTestFinished,
    }) => {
      const { database } = await databaseFixture(
        createDatabase,
        { startup: true },
        onTestFinished,
      );
      const result = database.transaction(async () => {
        throw new Error("transaction callback must not run");
      });
      await expect(result).rejects.toMatchObject({
        code: "08006",
        message: "startup rejected",
      });
      await expect(
        database.transaction(async (tx) => {
          return (await tx.execute(sql`select session_id`)).rows;
        }),
      ).resolves.toEqual([{ session_id: "2" }]);
    });

    it.for(["reject", "disconnect"] as const)(
      "discards a client after BEGIN %s and frees the only pool slot",
      async (begin, { onTestFinished }) => {
        const { database } = await databaseFixture(
          createDatabase,
          { begin },
          onTestFinished,
        );
        const result = database.transaction(
          async () => {
            throw new Error("transaction callback must not run");
          },
          { isolationLevel: "read committed" },
        );
        await expect(result).rejects.toMatchObject({
          query: "begin isolation level read committed",
          cause:
            begin === "reject"
              ? { code: "08006", message: "BEGIN rejected" }
              : { message: "Connection terminated unexpectedly" },
        });
        await expect(
          database.transaction(async (tx) => {
            return (await tx.execute(sql`select session_id`)).rows;
          }),
        ).resolves.toEqual([{ session_id: "2" }]);
      },
    );

    it.for([Object.freeze(new Error("callback failed")), "primitive failure"])(
      "preserves the original callback failure when rollback fails: %s",
      async (original, { onTestFinished }) => {
        const { database } = await databaseFixture(
          createDatabase,
          { rollback: true },
          onTestFinished,
        );
        await expect(
          database.transaction(async () => {
            throw original;
          }),
        ).rejects.toBe(original);
        await expect(
          database.transaction(async (tx) => {
            return (await tx.execute(sql`select session_id`)).rows;
          }),
        ).resolves.toEqual([{ session_id: "2" }]);
      },
    );

    it.for([false, true])(
      "preserves COMMIT failure when rollback failure is %s",
      async (rollback, { onTestFinished }) => {
        const { database } = await databaseFixture(
          createDatabase,
          { commit: true, rollback },
          onTestFinished,
        );
        await expect(
          database.transaction(async () => {
            return "not committed";
          }),
        ).rejects.toMatchObject({
          query: "commit",
          cause: { code: "40001", message: "COMMIT rejected" },
        });
        await expect(
          database.transaction(async (tx) => {
            return (await tx.execute(sql`select session_id`)).rows;
          }),
        ).resolves.toEqual([{ session_id: rollback ? "2" : "1" }]);
      },
    );

    it("reuses a successfully rolled-back session and preserves successful nested transactions", async ({
      onTestFinished,
    }) => {
      const { database } = await databaseFixture(
        createDatabase,
        {},
        onTestFinished,
      );
      const original = new Error("callback failed");
      await expect(
        database.transaction(async () => {
          throw original;
        }),
      ).rejects.toBe(original);
      await expect(
        database.transaction(async (tx) => {
          return tx.transaction(async (nested) => {
            return (await nested.execute(sql`select session_id`)).rows;
          });
        }),
      ).resolves.toEqual([{ session_id: "1" }]);
      await expect(
        database.transaction(async () => {
          return "committed";
        }),
      ).resolves.toBe("committed");
      await expect(
        database.transaction(async (tx) => {
          return (await tx.execute(sql`select session_id`)).rows;
        }),
      ).resolves.toEqual([{ session_id: "1" }]);
    });

    it("leaves a caller-owned client usable after successful and failed transactions", async ({
      onTestFinished,
    }) => {
      const { connection } = await databaseFixture(
        createDatabase,
        { rollback: true },
        onTestFinished,
      );
      const client = new Client(connection);
      await client.connect();
      try {
        const database = createDatabase(client);
        await expect(
          database.transaction(async () => {
            return "committed";
          }),
        ).resolves.toBe("committed");
        const original = new Error("caller failure");
        await expect(
          database.transaction(async () => {
            throw original;
          }),
        ).rejects.toBe(original);
        // The owner can recover the failed transaction and continue using its client.
        await client.query("rollback");
        await expect(client.query("select session_id")).resolves.toMatchObject({
          rows: [{ session_id: "1" }],
        });
      } finally {
        await client.end();
      }
    });
  },
);
