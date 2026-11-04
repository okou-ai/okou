import {
  ChartLine,
  ChartNoAxesColumnIncreasing,
  FileText,
  Handshake,
  ImagePlus,
  ListOrdered,
  MapPin,
  Megaphone,
  Search,
  Share2,
  ShoppingBag,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";

const TOOL_CAPABILITY_ICONS: Readonly<Record<string, LucideIcon | undefined>> =
  {
    "image-generation": ImagePlus,
    "web-search": Search,
    "web-extraction": FileText,
    "company-contacts": Users,
    "website-traffic": ChartLine,
    "keywords-rankings": ListOrdered,
    "ad-creatives": Megaphone,
    "creators-partners": Handshake,
    social: Share2,
    "product-research": ShoppingBag,
    finance: ChartNoAxesColumnIncreasing,
    "places-weather": MapPin,
  };

/** Router family IDs are open-ended; unknown families keep a generic glyph. */
export function getToolCapabilityIcon(toolId: string): LucideIcon {
  const icon = Object.hasOwn(TOOL_CAPABILITY_ICONS, toolId)
    ? TOOL_CAPABILITY_ICONS[toolId]
    : undefined;
  return icon ?? Wrench;
}
