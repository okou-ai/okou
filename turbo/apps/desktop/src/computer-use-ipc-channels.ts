export const COMPUTER_USE_CHANNELS = {
  getState: "computer-use:get-state",
  refreshPermissions: "computer-use:refresh-permissions",
  start: "computer-use:start",
  stop: "computer-use:stop",
  requestAccessibilityPermission: "computer-use:request-accessibility",
  requestScreenRecordingPermission: "computer-use:request-screen-recording",
  probeAutomationPermission: "computer-use:probe-automation",
  setKeepAwakeEnabled: "computer-use:set-keep-awake-enabled",
  setFilesystemPluginEnabled: "computer-use:set-filesystem-plugin-enabled",
  addFilesystemPluginAllowedDirectory:
    "computer-use:add-filesystem-plugin-allowed-directory",
  removeFilesystemPluginAllowedDirectory:
    "computer-use:remove-filesystem-plugin-allowed-directory",
  importMcpPluginServers: "computer-use:import-mcp-plugin-servers",
  setMcpPluginServerEnabled: "computer-use:set-mcp-plugin-server-enabled",
  removeMcpPluginServer: "computer-use:remove-mcp-plugin-server",
  openAccessibilitySettings: "computer-use:open-accessibility-settings",
  openScreenRecordingSettings: "computer-use:open-screen-recording-settings",
  openAutomationSettings: "computer-use:open-automation-settings",
  changed: "computer-use:changed",
} as const;
