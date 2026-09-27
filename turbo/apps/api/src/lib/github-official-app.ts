export function githubAppUrl(appSlug: string): string {
  return `https://github.com/apps/${encodeURIComponent(appSlug)}`;
}
