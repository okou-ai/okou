export type TemplatePickerEntryCategory =
  | "slides"
  | "illustration"
  | "video"
  | "website";

export function parseTemplatePickerEntryCategory(
  value: string | null,
): TemplatePickerEntryCategory | null {
  switch (value) {
    case "slides":
    case "illustration":
    case "video":
    case "website": {
      return value;
    }
    default: {
      return null;
    }
  }
}
