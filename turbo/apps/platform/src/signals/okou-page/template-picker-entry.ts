export type TemplatePickerEntryCategory = "slides" | "illustration" | "website";

export function parseTemplatePickerEntryCategory(
  value: string | null,
): TemplatePickerEntryCategory | null {
  switch (value) {
    case "slides":
    case "illustration":
    case "website": {
      return value;
    }
    default: {
      return null;
    }
  }
}
