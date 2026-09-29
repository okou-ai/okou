export type ConnectorGenerationType =
  | "audio"
  | "code"
  | "document"
  | "image"
  | "text";

type BuiltInGenerationType =
  | "dashboard-design"
  | "docs-design"
  | "image"
  | "mobile-app-design"
  | "music"
  | "poster"
  | "presentation"
  | "report"
  | "sprite"
  | "website";
export type GenerationType = ConnectorGenerationType | BuiltInGenerationType;

export function getConnectorGenerationType(
  generationType: GenerationType,
): ConnectorGenerationType | null {
  switch (generationType) {
    case "music":
      return "audio";
    case "dashboard-design":
    case "docs-design":
    case "mobile-app-design":
    case "poster":
    case "presentation":
    case "report":
    case "sprite":
    case "website":
      return null;
    case "audio":
    case "code":
    case "document":
    case "image":
    case "text":
      return generationType;
  }
}
