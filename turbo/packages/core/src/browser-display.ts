/** A viewer surface in CSS pixels and its requested physical density. */
export interface BrowserDisplaySize {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

const maximumDimension = 4096;
const maximumArea = 3840 * 2160;

/** Shared by window admission and the viewer's continuous adaptation. */
export function constrainBrowserDisplay(size: BrowserDisplaySize) {
  if (
    ![size.width, size.height, size.dpr].every((value) => {
      return Number.isFinite(value) && value > 0;
    })
  ) {
    return null;
  }
  const scale = Math.min(
    1,
    maximumDimension / size.width,
    maximumDimension / size.height,
    maximumDimension / (size.width * size.dpr),
    maximumDimension / (size.height * size.dpr),
    Math.sqrt(maximumArea / size.width / size.height) / size.dpr,
  );
  const width = Math.max(1, Math.floor(size.width * scale));
  const height = Math.max(1, Math.floor(size.height * scale));
  if (
    width * size.dpr > maximumDimension ||
    height * size.dpr > maximumDimension ||
    width * height * size.dpr * size.dpr > maximumArea
  ) {
    return null;
  }
  return { width, height, dpr: size.dpr, constrained: scale < 1 };
}

/** Native content DIP, independent of browser chrome and CSS page zoom. */
export function browserDisplayContents(
  size: BrowserDisplaySize,
  nativeDpr: number,
) {
  if (!Number.isFinite(nativeDpr) || nativeDpr <= 0) {
    throw new Error("The browser display scale is unavailable.");
  }
  const densityScale = size.dpr / nativeDpr;
  return {
    width: Math.max(1, Math.round(size.width * densityScale)),
    height: Math.max(1, Math.round(size.height * densityScale)),
  };
}
