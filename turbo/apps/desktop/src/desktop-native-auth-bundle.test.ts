import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  ["Okou", "https://app.okou.ai", "ai.okou.desktop"],
  ["Okou Dev", "http://localhost:3002", "ai.okou.desktop.dev"],
])("packages branded native auth for %s", (name, platformUrl, bundleId) => {
  const directory = mkdtempSync(join(tmpdir(), "desktop-native-auth-bundle-"));
  temporaryDirectories.push(directory);
  const contents = join(directory, `${name}.app`, "Contents");
  const native = join(contents, "Resources", "native");
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, "clerk-auth-helper"), "native auth executable", {
    mode: 0o755,
  });
  writeFileSync(join(contents, "Resources", "icon.icns"), "Okou icon");

  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `const config = require(process.argv[1]);
config.hooks.postPackage({}, { platform: "darwin", outputPaths: [process.argv[2]] });`,
      resolve(__dirname, "../forge.config.js"),
      directory,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OKOU_DESKTOP_PLATFORM_URL: platformUrl,
        OKOU_DESKTOP_SKIP_SIGNING: "true",
        OKOU_DESKTOP_NOTARIZE: "false",
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const authContents = join(contents, "Helpers", "Okou.app", "Contents");
  const executable = join(authContents, "MacOS", "Okou");
  expect(readFileSync(executable, "utf8")).toBe("native auth executable");
  expect(statSync(executable).mode & 0o777).toBe(0o755);
  expect(
    readFileSync(join(authContents, "Resources", "icon.icns"), "utf8"),
  ).toBe("Okou icon");
  const plist = readFileSync(join(authContents, "Info.plist"), "utf8");
  for (const key of [
    "CFBundleExecutable",
    "CFBundleName",
    "CFBundleDisplayName",
  ]) {
    expect(plist).toContain(`<key>${key}</key><string>Okou</string>`);
  }
  expect(plist).toContain(
    `<key>CFBundleIdentifier</key><string>${bundleId}</string>`,
  );
  expect(plist).toContain("<key>LSUIElement</key><true/>");
});
