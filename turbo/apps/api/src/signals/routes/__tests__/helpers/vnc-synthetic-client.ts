import { spawnSync } from "node:child_process";

// Generate a disposable synthetic identity entirely through pipes: no key files,
// command-line secrets, or checked-in private keys. The Ubuntu API test image
// supplies OpenSSL. Never use this identity outside isolated tests.
const generated = spawnSync(
  "openssl",
  [
    "req",
    "-new",
    "-x509",
    "-newkey",
    "ed25519",
    "-nodes",
    "-keyout",
    "-",
    "-out",
    "-",
    "-days",
    "2",
    "-subj",
    "/CN=synthetic-vnc-client",
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024 },
);
if (generated.status !== 0) {
  throw new Error("OpenSSL did not produce a disposable client test identity");
}
const chain =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/u.exec(
    generated.stdout,
  );
const key =
  /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/u.exec(
    generated.stdout,
  );
if (!chain || !key) {
  throw new Error("OpenSSL did not produce a disposable client test identity");
}
export const certificateChain = chain[0];
export const privateKey = key[0];
