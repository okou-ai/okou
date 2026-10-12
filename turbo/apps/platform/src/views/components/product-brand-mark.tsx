import { useGet } from "ccstate-react";

import {
  platformOkouWordmarkDarkImg,
  platformOkouWordmarkLightImg,
} from "../../lib/static-assets.ts";
import { BRAND_NAME } from "../../signals/branding.ts";
import { theme$ } from "../../signals/theme.ts";

type ProductBrandMarkSize = "hero" | "default" | "compact" | "small";

export function ProductBrandMark({
  decorative = false,
  size = "default",
}: {
  decorative?: boolean;
  size?: ProductBrandMarkSize;
}) {
  const theme = useGet(theme$);

  const dimensions =
    size === "hero"
      ? { width: 152, height: 40 }
      : size === "default"
        ? { width: 91, height: 24 }
        : size === "compact"
          ? { width: 76, height: 20 }
          : { width: 60, height: 16 };

  return (
    <img
      alt={decorative ? "" : BRAND_NAME}
      aria-hidden={decorative || undefined}
      className="block h-auto"
      height={dimensions.height}
      src={
        theme === "dark"
          ? platformOkouWordmarkLightImg
          : platformOkouWordmarkDarkImg
      }
      width={dimensions.width}
    />
  );
}
