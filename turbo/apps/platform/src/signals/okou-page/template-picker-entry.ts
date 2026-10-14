export type TemplatePickerEntryCategory =
  "slides" | "document" | "illustration" | "website";

export function parseTemplatePickerEntryCategory(
  value: string | null,
): TemplatePickerEntryCategory | null {
  switch (value) {
    case "slides":
    case "document":
    case "illustration":
    case "website": {
      return value;
    }
    default: {
      return null;
    }
  }
}
