import type {
  DesktopRecorderSource,
  DesktopRecorderWindowOption,
  DesktopRecorderWindowPreview,
} from "./desktop-recorder-types";

/**
 * Applications whose windows are system chrome rather than something a user
 * would ever record: menu bar extras, the Dock, notification banners, and the
 * recorder's own overlays. Left in the list they crowd out the real windows —
 * one machine offered twenty-eight of them ahead of any document.
 *
 * These are macOS bundle identifiers, not desktop auth callback schemes. The
 * two namespaces can spell an app the same way while meaning different things,
 * so an entry here stands or falls on whether its windows are worth hiding.
 */
const CHROME_BUNDLE_IDS: ReadonlySet<string> = new Set([
  "ai.okou.desktop",
  "com.apple.controlcenter",
  "com.apple.dock",
  "com.apple.notificationcenterui",
  "com.apple.spotlight",
  "com.apple.systemuiserver",
  "com.apple.WindowManager",
  "com.apple.wifi.WiFiAgent",
]);

/** The CoreGraphics window id that joins a preview to its source. */
function windowId(id: string): string | null {
  const parts = id.split(":");
  return parts[0] === "window" && parts[1] ? parts[1] : null;
}

/**
 * Builds the list the window picker shows.
 *
 * A window without a preview is dropped rather than shown as an empty tile: the
 * whole point of the picker is that the user recognises the window by sight,
 * and a nameless blank box is worse than one fewer choice.
 */
export function buildWindowOptions(
  sources: readonly DesktopRecorderSource[],
  previews: readonly DesktopRecorderWindowPreview[],
): readonly DesktopRecorderWindowOption[] {
  const previewById = new Map<string, DesktopRecorderWindowPreview>();
  for (const preview of previews) {
    const id = windowId(preview.id);
    if (id) {
      previewById.set(id, preview);
    }
  }

  const options: DesktopRecorderWindowOption[] = [];
  for (const source of sources) {
    if (source.kind !== "window") {
      continue;
    }
    if (source.bundleId && CHROME_BUNDLE_IDS.has(source.bundleId)) {
      continue;
    }
    const id = windowId(source.id);
    const preview = id ? previewById.get(id) : undefined;
    if (!preview) {
      continue;
    }
    options.push({
      id: source.id,
      title: source.title,
      appName: source.appName ?? source.title,
      previewDataUrl: preview.previewDataUrl,
    });
  }

  // Grouped by application so a user hunting for one app's window reads one
  // place rather than the capture order, which follows stacking.
  return options.sort((left, right) => {
    return (
      left.appName.localeCompare(right.appName) ||
      left.title.localeCompare(right.title)
    );
  });
}
