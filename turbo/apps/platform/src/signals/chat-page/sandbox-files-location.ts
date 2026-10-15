import { CANONICAL_GUEST_HOME_DIR } from "@okouai/api-contracts/contracts/runner-primitives";

interface FilesPathSegment {
  readonly nameToken: string;
  readonly displayName: string;
}
export type FilesLocation = readonly FilesPathSegment[];

// Only this fixed ASCII contract is encoded from labels. All received names
// keep their independently validated raw token throughout navigation.
export const FILES_HOME_LOCATION: FilesLocation =
  CANONICAL_GUEST_HOME_DIR.split("/")
    .filter(Boolean)
    .map((name) => {
      return {
        nameToken: btoa(name)
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, ""),
        displayName: name,
      };
    });

export function filesLocationTokens(location: FilesLocation): string[] {
  return location.map((part) => {
    return part.nameToken;
  });
}

export function filesLocationLabel(location: FilesLocation): string {
  return (
    "/" +
    location
      .map((part) => {
        return part.displayName;
      })
      .join("/")
  );
}

export interface FilesViewPreference {
  readonly rootEntries: number;
  readonly expanded: readonly {
    readonly path: readonly string[];
    readonly entries: number;
  }[];
  readonly scrollTop: number;
}

export const FILES_VIEW_BYTES = 64 * 1024;

/** Preferences contain no old directory payloads, listing ids or cursors. */
export function retainFilesViewPreferences(
  previous: ReadonlyMap<string, FilesViewPreference>,
  location: FilesLocation,
  preference: FilesViewPreference,
): ReadonlyMap<string, FilesViewPreference> {
  const key = JSON.stringify(filesLocationTokens(location));
  const next = new Map(previous);
  next.delete(key);
  next.set(key, preference);
  for (const candidate of next.keys()) {
    if (
      next.size <= 8 &&
      new TextEncoder().encode(JSON.stringify([...next])).byteLength <=
        FILES_VIEW_BYTES / 2
    ) {
      break;
    }
    next.delete(candidate);
  }
  return next;
}
