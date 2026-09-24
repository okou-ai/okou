export const DESKTOP_AUTH_CHANNELS = {
  getState: "desktop-auth:get-state",
  getLoginMethod: "desktop-auth:get-login-method",
  setLoginMethod: "desktop-auth:set-login-method",
  openSignIn: "desktop-auth:open-sign-in",
  openOrgSelection: "desktop-auth:open-org-selection",
  signOut: "desktop-auth:sign-out",
  completeSignIn: "desktop-auth:complete-sign-in",
  changed: "desktop-auth:changed",
} as const;
