import { tapError } from "../signals/utils.ts";

/**
 * Save a stream straight to a file the viewer chooses.
 *
 * Only Chromium ships the save picker; Firefox and WebKit have both declined
 * it, so this is a progressive enhancement over holding the bytes in memory.
 * The picker also needs the activation of the click that opened it, which by
 * the time a download knows its size is several awaits old, so every refusal —
 * unsupported, dismissed, or expired — resolves to null for the caller to
 * handle rather than failing the download.
 */

interface FileSystemWritableStream {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface SaveFileHandle {
  createWritable(): Promise<FileSystemWritableStream>;
}

interface SaveFilePickerOptions {
  readonly suggestedName?: string;
  readonly types?: readonly {
    readonly description?: string;
    readonly accept: Readonly<Record<string, readonly string[]>>;
  }[];
}

declare global {
  interface Window {
    showSaveFilePicker?: (
      options?: SaveFilePickerOptions,
    ) => Promise<SaveFileHandle>;
  }
}

export interface FileSink {
  readonly write: (chunk: Uint8Array) => Promise<void>;
  readonly finish: () => Promise<void>;
  readonly abandon: () => Promise<void>;
}

export async function saveFileSink(
  options: SaveFilePickerOptions,
): Promise<FileSink | null> {
  if (typeof window.showSaveFilePicker !== "function") {
    return null;
  }
  const handle = await tapError(window.showSaveFilePicker(options));
  if (!handle) {
    return null;
  }
  const writable = await tapError(handle.createWritable());
  if (!writable) {
    return null;
  }
  return {
    write: (chunk) => {
      return writable.write(chunk);
    },
    finish: () => {
      return writable.close();
    },
    abandon: () => {
      return writable.abort();
    },
  };
}
