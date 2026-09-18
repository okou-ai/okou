import path from "node:path";

const DESKTOP_RENDERER_PROTOCOL = "vm0-desktop";
const DESKTOP_RENDERER_HOST = "renderer";

export function desktopRendererUrl(): string {
  return `${DESKTOP_RENDERER_PROTOCOL}://${DESKTOP_RENDERER_HOST}/index.html`;
}

export function desktopRendererRoot(distDir: string = __dirname): string {
  return path.join(distDir, "renderer");
}

export function desktopRendererFilePath(
  rawUrl: string,
  distDir: string = __dirname,
): string | null {
  const url = new URL(rawUrl);
  if (
    url.protocol !== `${DESKTOP_RENDERER_PROTOCOL}:` ||
    url.hostname !== DESKTOP_RENDERER_HOST
  ) {
    return null;
  }

  const rendererRoot = desktopRendererRoot(distDir);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const candidate = path.normalize(
    path.join(rendererRoot, decodeURIComponent(requestedPath)),
  );
  if (
    candidate === rendererRoot ||
    candidate.startsWith(`${rendererRoot}${path.sep}`)
  ) {
    return candidate;
  }
  return null;
}

export function isDesktopRendererUrl(
  rawUrl: string,
  rendererUrl: string,
): boolean {
  try {
    const url = new URL(rawUrl);
    const expected = new URL(rendererUrl);
    return (
      url.protocol === expected.protocol &&
      url.hostname === expected.hostname &&
      url.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}
