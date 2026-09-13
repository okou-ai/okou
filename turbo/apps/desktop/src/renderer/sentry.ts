import { init as initElectronSentry, setTags } from "@sentry/electron/renderer";
import { init as initReactSentry } from "@sentry/react";

declare const __DESKTOP_SENTRY_ENABLED__: boolean;

export function initRendererSentry(): void {
  if (!__DESKTOP_SENTRY_ENABLED__) {
    return;
  }

  initElectronSentry(
    {
      enableLogs: false,
      sendDefaultPii: false,
      tracesSampleRate: 0,
    },
    initReactSentry,
  );
  setTags({
    app: "desktop",
    component: "electron-renderer",
  });
}
