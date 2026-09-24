import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  readDesktopLoginMethod,
  writeDesktopLoginMethod,
} from "./desktop-login-method";

const directory = mkdtempSync(path.join(os.tmpdir(), "desktop-login-method-"));
const preferencesPath = path.join(directory, "desktop-preferences.json");

afterEach(() => {
  rmSync(preferencesPath, { force: true });
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("defaults to browser sign-in and honors the opt-in environment", () => {
  expect(readDesktopLoginMethod(preferencesPath)).toBe("browser");
  vi.stubEnv("OKOU_DESKTOP_NATIVE_CLERK", "true");
  expect(readDesktopLoginMethod(preferencesPath)).toBe("native");
});

it("persists the chosen method and preserves other preferences", () => {
  writeFileSync(preferencesPath, '{"keepAwakeEnabled":true}\n');
  vi.stubEnv("OKOU_DESKTOP_NATIVE_CLERK", "true");
  writeDesktopLoginMethod(preferencesPath, "browser");

  expect(readDesktopLoginMethod(preferencesPath)).toBe("browser");
  expect(JSON.parse(readFileSync(preferencesPath, "utf8"))).toEqual({
    keepAwakeEnabled: true,
    loginMethod: "browser",
  });

  writeDesktopLoginMethod(preferencesPath, "native");
  expect(readDesktopLoginMethod(preferencesPath)).toBe("native");
});
