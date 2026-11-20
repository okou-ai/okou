import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const directory = await mkdtemp(join(tmpdir(), "runner-transport-tls-"));
try {
  const cert = join(directory, "cert.pem");
  const key = join(directory, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(import.meta.dirname, "runner-dispatch-transport.node-test.mjs"),
      cert,
      key,
    ],
    { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdio: "inherit" },
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
