import {
  readDesktopPreferenceRecord,
  writeDesktopPreferenceRecord,
} from "./desktop-preferences";

export type DesktopLoginMethod = "browser" | "native";

const PREFERENCE_KEY = "loginMethod";

export function readDesktopLoginMethod(filePath: string): DesktopLoginMethod {
  const value = readDesktopPreferenceRecord(filePath)[PREFERENCE_KEY];
  if (value === "browser" || value === "native") return value;
  return process.env.OKOU_DESKTOP_NATIVE_CLERK === "true"
    ? "native"
    : "browser";
}

export function writeDesktopLoginMethod(
  filePath: string,
  method: DesktopLoginMethod,
): void {
  writeDesktopPreferenceRecord(filePath, {
    ...readDesktopPreferenceRecord(filePath),
    [PREFERENCE_KEY]: method,
  });
}
