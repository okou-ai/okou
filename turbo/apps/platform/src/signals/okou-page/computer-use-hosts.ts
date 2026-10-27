import { computed } from "ccstate";
import type { ComputerUseHost } from "@okouai/api-contracts/contracts/computer-use";
import { sortRemoteHosts } from "../../lib/remote-resource-order.ts";
import { resolveApiBaseForNavigation } from "../api-base.ts";
import { tapError } from "../utils.ts";

const OKOU_DESKTOP_DMG_DOWNLOAD_PATH =
  "/api/desktop/updates/stable/darwin/arm64/dmg";

export const OKOU_DESKTOP_DOWNLOAD_URL = new URL(
  OKOU_DESKTOP_DMG_DOWNLOAD_PATH,
  resolveApiBaseForNavigation("api"),
).toString();

type DesktopDownloadSupportStatus = "available" | "unsupported-intel-mac";

interface UserAgentDataValues {
  readonly architecture?: string;
  readonly platform?: string;
}

interface DesktopNavigator {
  readonly platform?: string;
  readonly userAgent?: string;
  readonly userAgentData?: {
    readonly platform?: string;
    readonly getHighEntropyValues?: (
      hints: readonly string[],
    ) => Promise<UserAgentDataValues>;
  };
}

function isMacPlatform(
  platform: string | undefined,
  userAgent: string | undefined,
): boolean {
  return (
    Boolean(platform?.toLowerCase().includes("mac")) ||
    /Macintosh/i.test(userAgent ?? "")
  );
}

function isIntelArchitecture(architecture: string | undefined): boolean {
  const normalized = architecture?.toLowerCase();
  return (
    normalized === "x86" ||
    normalized === "x86_64" ||
    normalized === "amd64" ||
    normalized === "ia32"
  );
}

async function isUnsupportedIntelMacForDesktop(
  navigatorRef: DesktopNavigator | null | undefined = typeof navigator ===
  "undefined"
    ? undefined
    : navigator,
): Promise<boolean> {
  const userAgentData = navigatorRef?.userAgentData;
  if (!navigatorRef || !userAgentData?.getHighEntropyValues) {
    return false;
  }

  // eslint-disable-next-line ccstate/no-tap-error -- Legacy use as of 2026/10/21: optional architecture detection must not block Desktop downloads.
  const highEntropyValues = await tapError(
    userAgentData.getHighEntropyValues(["architecture", "platform"]),
  );
  if (!highEntropyValues) {
    return false;
  }

  const platform =
    highEntropyValues.platform ??
    userAgentData.platform ??
    navigatorRef.platform;
  return (
    isMacPlatform(platform, navigatorRef.userAgent) &&
    isIntelArchitecture(highEntropyValues.architecture)
  );
}

export const desktopDownloadSupportStatus$ = computed(
  async (): Promise<DesktopDownloadSupportStatus> => {
    return (await isUnsupportedIntelMacForDesktop())
      ? "unsupported-intel-mac"
      : "available";
  },
);

type SelectableComputerUseHost = Pick<
  ComputerUseHost,
  "id" | "displayName" | "status"
>;

export function selectedComputerUseHostId(
  hosts: readonly { readonly id: string }[],
  selectedHostId: string | null | undefined,
): string | null {
  if (!selectedHostId) {
    return null;
  }
  return hosts.some((host) => {
    return host.id === selectedHostId;
  })
    ? selectedHostId
    : null;
}

export function visibleComputerUseHosts<Host extends SelectableComputerUseHost>(
  hosts: readonly Host[],
  selectedHostId: string | null | undefined,
  locale: string,
): Host[] {
  const selected = selectedComputerUseHostId(hosts, selectedHostId);
  return sortRemoteHosts(
    hosts.filter((host) => {
      return host.status === "online" || host.id === selected;
    }),
    locale,
  );
}
