import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./cloudflared-ssh.sh", import.meta.url));
const packageBytes = "verified Debian package fixture\n";
const packageSha256 = createHash("sha256").update(packageBytes).digest("hex");
const alternateVersion = "2026.1.2";
const verifiedArguments = [
  "--version",
  alternateVersion,
  "--sha256",
  packageSha256,
];

function runProvision(t, args = verifiedArguments, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "okou-cloudflared-ssh-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  const remoteTmp = join(directory, "remote-tmp");
  mkdirSync(bin);
  mkdirSync(remoteTmp);
  const isolatedScript = join(directory, "cloudflared-ssh.sh");
  // Copy the command unchanged so an operator's adjacent .env.local is excluded.
  copyFileSync(script, isolatedScript);
  for (const command of [
    "bash",
    "cp",
    "dirname",
    "grep",
    "jq",
    "mktemp",
    "rm",
    "sha256sum",
  ]) {
    symlinkSync(`/usr/bin/${command}`, join(bin, command));
  }
  const commands = {
    curl: String.raw`
url=""
output=""
while (($#)); do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf 'curl:%s\n' "$url" >> "$EVENTS"
case "$url" in
  https://api.cloudflare.com/client/v4/zones\?name=*)
    printf '{"result":[{"id":"zone"}]}\n' ;;
  https://api.cloudflare.com/client/v4/accounts/account/cfd_tunnel\?*)
    printf '{"result":[{"id":"tunnel"}]}\n' ;;
  https://api.cloudflare.com/client/v4/accounts/account/cfd_tunnel/tunnel/configurations)
    printf '{"success":true}\n' ;;
  https://api.cloudflare.com/client/v4/zones/zone/dns_records\?*)
    printf '{"result":[{"id":"record"}]}\n' ;;
  https://api.cloudflare.com/client/v4/zones/zone/dns_records/record)
    printf '{"success":true}\n' ;;
  https://api.cloudflare.com/client/v4/accounts/account/cfd_tunnel/tunnel/token)
    printf '{"result":"test-tunnel-token"}\n' ;;
  https://github.com/cloudflare/cloudflared/releases/download/*/cloudflared-linux-*.deb)
    printf '%s' "$PACKAGE_BYTES" > "$output"
    exit "$DOWNLOAD_STATUS" ;;
  *) echo "Unexpected HTTP request: $url" >&2; exit 99 ;;
esac
`,
    ssh: String.raw`
printf 'ssh\n' >> "$EVENTS"
shift
exec "$@"
`,
    dpkg: String.raw`
case "$1" in
  --print-architecture) printf '%s\n' "$DEBIAN_ARCH" ;;
  -i)
    printf 'dpkg\n' >> "$EVENTS"
    if [[ "$INSTALL_STATUS" != 0 ]]; then exit "$INSTALL_STATUS"; fi
    cp -- "$2" "$INSTALLED_PACKAGE" ;;
  *) exit 99 ;;
esac
`,
    sudo: 'exec "$@"',
    cloudflared: String.raw`
if [[ "$1" == --version ]]; then
  if [[ -z "$INSTALLED_VERSION" ]]; then exit 1; fi
  printf 'cloudflared version %s (built fixture)\n' "$INSTALLED_VERSION"
else
  printf 'service:%s\n' "$*" >> "$EVENTS"
fi
`,
    systemctl: 'printf \'systemctl:%s\\n\' "$*" >> "$EVENTS"',
    sleep: "exit 0",
  };
  for (const [name, body] of Object.entries(commands)) {
    writeFileSync(
      join(bin, name),
      `#!/bin/bash\nset -euo pipefail\n${body}\n`,
      {
        mode: 0o755,
      },
    );
  }
  const events = join(directory, "events");
  const installedPackage = join(directory, "installed.deb");
  writeFileSync(events, "");
  const result = spawnSync(
    "/bin/bash",
    [
      isolatedScript,
      "provision",
      "host.example.test",
      "--domain",
      "example.test",
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: bin,
        TMPDIR: remoteTmp,
        CF_TUNNEL_API_TOKEN: "test-api-token",
        CF_TUNNEL_ACCOUNT_ID: "account",
        EVENTS: events,
        INSTALLED_PACKAGE: installedPackage,
        DEBIAN_ARCH: "amd64",
        PACKAGE_BYTES: packageBytes,
        DOWNLOAD_STATUS: "0",
        INSTALL_STATUS: "0",
        INSTALLED_VERSION: "",
        ...overrides,
      },
    },
  );
  assert.equal(result.error, undefined);
  return {
    ...result,
    events: readFileSync(events, "utf8"),
    installed: existsSync(installedPackage)
      ? readFileSync(installedPackage, "utf8")
      : undefined,
    temporaryFiles: readdirSync(remoteTmp),
  };
}

for (const architecture of ["amd64", "arm64"]) {
  test(`installs a checksum-verified explicit release on ${architecture}`, (t) => {
    const result = runProvision(t, verifiedArguments, {
      DEBIAN_ARCH: architecture,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.installed, packageBytes);
    assert.match(
      result.events,
      new RegExp(`cloudflared-linux-${architecture}\\.deb`),
    );
    assert.match(result.events, /service:service install test-tunnel-token/);
    assert.deepEqual(result.temporaryFiles, []);
  });

  test(`rejects a corrupt download against the default ${architecture} pin`, (t) => {
    const result = runProvision(t, [], { DEBIAN_ARCH: architecture });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /SHA-256 verification failed/);
    assert.doesNotMatch(result.events, /dpkg|service:|systemctl:/);
    assert.equal(result.installed, undefined);
    assert.deepEqual(result.temporaryFiles, []);
  });
}

test("rejects an explicit checksum mismatch before installation or service changes", (t) => {
  const result = runProvision(t, [
    "--version",
    alternateVersion,
    "--sha256",
    "0".repeat(64),
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /SHA-256 verification failed/);
  assert.doesNotMatch(result.events, /dpkg|service:|systemctl:/);
  assert.deepEqual(result.temporaryFiles, []);
});

for (const [failure, status] of [
  ["DOWNLOAD_STATUS", 22],
  ["INSTALL_STATUS", 42],
]) {
  test(`cleans up and stops before service setup on ${failure}`, (t) => {
    const result = runProvision(t, verifiedArguments, {
      [failure]: String(status),
    });
    assert.equal(result.status, status, result.stderr);
    assert.doesNotMatch(result.events, /service:|systemctl:/);
    if (failure === "DOWNLOAD_STATUS")
      assert.doesNotMatch(result.events, /dpkg/);
    assert.deepEqual(result.temporaryFiles, []);
  });
}

test("rejects invalid or missing integrity inputs before external work", (t) => {
  for (const args of [
    ["--version", alternateVersion],
    ["--version", alternateVersion, "--sha256", ""],
    ["--sha256", "invalid"],
    ["--sha256", "g".repeat(64)],
    ["--version", "unsafe;version", "--sha256", packageSha256],
    ["--version", "", "--sha256", packageSha256],
  ]) {
    const result = runProvision(t, args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.events, "");
    assert.equal(result.installed, undefined);
  }
});

test("rejects unsupported Debian architectures before package installation", (t) => {
  const result = runProvision(t, verifiedArguments, { DEBIAN_ARCH: "riscv64" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Unsupported cloudflared Debian architecture/);
  assert.doesNotMatch(result.events, /releases\/download|dpkg|service:/);
});

test("skips the package download when the exact requested version is installed", (t) => {
  const result = runProvision(t, verifiedArguments, {
    INSTALLED_VERSION: alternateVersion,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.events, /releases\/download|dpkg/);
  assert.match(result.events, /service:service install/);
  assert.deepEqual(result.temporaryFiles, []);
});

test("does not mistake a different patch version for the requested release", (t) => {
  const result = runProvision(t, verifiedArguments, {
    INSTALLED_VERSION: `${alternateVersion}0`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.installed, packageBytes);
});
