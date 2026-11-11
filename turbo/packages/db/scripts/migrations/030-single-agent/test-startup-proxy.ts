import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";

// Model a database gateway that does not forward optional startup settings.
// This fixture fronts the local plain-TCP Postgres test service, not production.
const host = process.argv[2];
const port = Number(process.argv[3]);
assert.ok(host);
assert.ok(Number.isInteger(port) && port > 0);
const dropped = new Set(["default_transaction_read_only", "statement_timeout"]);

const server = createServer((client) => {
  const upstream = createConnection({ host, port });
  client.on("error", () => {
    upstream.destroy();
  });
  upstream.on("error", () => {
    client.destroy();
  });
  client.on("close", () => {
    upstream.destroy();
  });
  upstream.on("close", () => {
    client.destroy();
  });
  let buffered = Buffer.alloc(0);
  const startup = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length < 4) return;
    const size = buffered.readInt32BE(0);
    if (size < 8 || size > 65_536) {
      client.destroy();
      return;
    }
    if (buffered.length < size) return;
    if (buffered.readInt32BE(4) !== 196608) {
      client.destroy();
      return;
    }
    const fields = buffered
      .subarray(8, size - 1)
      .toString("utf8")
      .split("\0");
    const retained: string[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const key = fields[i];
      const value = fields[i + 1];
      assert.ok(key !== undefined && value !== undefined);
      if (!dropped.has(key)) retained.push(key, value);
    }
    const parameters = Buffer.from(retained.join("\0") + "\0\0");
    const header = Buffer.alloc(8);
    header.writeInt32BE(parameters.length + 8, 0);
    header.writeInt32BE(196608, 4);
    client.off("data", startup);
    upstream.write(Buffer.concat([header, parameters]));
    if (buffered.length > size) upstream.write(buffered.subarray(size));
    client.pipe(upstream);
    upstream.pipe(client);
  };
  client.on("data", startup);
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  console.log(JSON.stringify({ port: address.port }));
});
