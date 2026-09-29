export type ConnectorGenerationType =
  | "audio"
  | "code"
  | "document"
  | "image"
  | "text";

export type GenerationType =
  | "code"
  | "dashboard-design"
  | "document"
  | "docs-design"
  | "image"
  | "mobile-app-design"
  | "music"
  | "poster"
  | "presentation"
  | "report"
  | "sprite"
  | "text"
  | "website";

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
    case "code":
    case "document":
    case "image":
    case "text":
      return generationType;
  }
}
