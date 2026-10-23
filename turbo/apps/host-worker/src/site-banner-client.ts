const banner = document.getElementById("okou-site-banner");
const root = banner?.shadowRoot;
const share = root?.querySelector<HTMLButtonElement>(
  "[data-okou-banner-share]",
);
const fullscreen = root?.querySelector<HTMLButtonElement>(
  "[data-okou-banner-fullscreen]",
);
const status = root?.querySelector<HTMLElement>("[data-okou-banner-status]");
const message = root?.querySelector<HTMLElement>("[data-okou-banner-message]");
let notificationTimer: ReturnType<typeof setTimeout> | undefined;

function notify(text: string, error = false) {
  if (!status || !message) return;
  clearTimeout(notificationTimer);
  status.toggleAttribute("data-error", error);
  message.textContent = text;
  status.hidden = false;
  notificationTimer = setTimeout(() => {
    status.hidden = true;
  }, 3000);
}

window.addEventListener("pagehide", () => {
  clearTimeout(notificationTimer);
  if (status) status.hidden = true;
});

share?.addEventListener("click", () => {
  const siteUrl = banner?.dataset.siteUrl;
  if (!siteUrl) return;
  if (!navigator.clipboard) {
    notify("Could not copy link", true);
    return;
  }
  return navigator.clipboard.writeText(siteUrl).then(
    () => {
      notify("Link copied");
    },
    () => {
      notify("Could not copy link", true);
    },
  );
});

fullscreen?.addEventListener("click", () => {
  if (typeof document.documentElement.requestFullscreen !== "function") {
    notify("Fullscreen is unavailable", true);
    return;
  }
  return document.documentElement.requestFullscreen().catch(() => {
    notify("Fullscreen is unavailable", true);
  });
});

export {};
