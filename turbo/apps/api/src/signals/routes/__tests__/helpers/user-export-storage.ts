import AdmZip from "adm-zip";

export function readExportText(zip: AdmZip, path: string): string {
  const entry = zip.getEntry(path);
  if (entry === null) {
    throw new Error(`Expected export entry ${path}`);
  }
  return entry.getData().toString("utf8");
}

export function readExportJsonLines(zip: AdmZip, path: string) {
  const text = readExportText(zip, path).trimEnd();
  return text.length === 0
    ? []
    : text.split("\n").map((line) => {
        return JSON.parse(line) as Record<string, unknown>;
      });
}
