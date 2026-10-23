const banner = document.getElementById("okou-site-banner");
const root = banner?.shadowRoot;
const share = root?.querySelector<HTMLButtonElement>(
  "[data-okou-banner-share]",
);
const fullscreen = root?.querySelector<HTMLButtonElement>(
  "[data-okou-banner-fullscreen]",
);
const status = root?.querySelector<HTMLElement>("[data-okou-banner-status]");

share?.addEventListener("click", () => {
  const siteUrl = banner?.dataset.siteUrl;
  if (!siteUrl) return;
  if (!navigator.clipboard) {
    if (status) status.textContent = "Could not copy link";
    return;
  }
  return navigator.clipboard.writeText(siteUrl).then(
    () => {
      if (status) status.textContent = "Link copied";
      share.dataset.copied = "";
      share.setAttribute("aria-label", "Link copied");
    },
    () => {
      if (status) status.textContent = "Could not copy link";
    },
  );
});

fullscreen?.addEventListener("click", () => {
  if (typeof document.documentElement.requestFullscreen !== "function") {
    if (status) status.textContent = "Fullscreen is unavailable";
    return;
  }
  return document.documentElement.requestFullscreen().catch(() => {
    if (status) status.textContent = "Fullscreen is unavailable";
  });
});

export {};
