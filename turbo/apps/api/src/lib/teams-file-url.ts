const ALLOWED_TEAMS_FILE_HOSTS = [
  "1drv.ms",
  "onedrive.live.com",
  "sharepoint.com",
  "trafficmanager.net",
  "microsoft.com",
  "office.com",
] as const;

export function isAllowedTeamsDownloadUrl(url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  return (
    parsed.protocol === "https:" &&
    ALLOWED_TEAMS_FILE_HOSTS.some((allowed) => {
      return host === allowed || host.endsWith(`.${allowed}`);
    })
  );
}
