import type { ComputerUseDriverController } from "./computer-use-driver";
import {
  createComputerUsePermissions,
  type ComputerUsePermissionQuery,
} from "./computer-use-permissions";
import type { ComputerUsePermissionState } from "./computer-use-types";

export function createDesktopComputerUsePermissions(options: {
  readonly driver: ComputerUseDriverController;
  readonly refreshNative: (
    query?: ComputerUsePermissionQuery,
  ) => Promise<ComputerUsePermissionState | null>;
}) {
  const permissions = createComputerUsePermissions(
    (read) => options.driver.withPermissionProvider(read),
    (query) => options.refreshNative(query),
  );
  return {
    ...permissions,
    refreshReady: async (query?: ComputerUsePermissionQuery) => {
      if (options.driver.getCapabilities().length > 0) {
        try {
          const fresh = await options.refreshNative(query);
          if (fresh) return fresh;
        } catch {
          // Driver ownership already withdrew admission and retained cleanup.
          return { accessibility: false, screenRecording: false };
        }
      }
      return permissions.getComputerUsePermissionState();
    },
  };
}
