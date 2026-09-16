import { command, computed, state } from "ccstate";
import type {
  ColorTheme,
  ThemePreference,
} from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cookieSignals, refreshCookies$ } from "./external/cookie.ts";
import { featureSwitchState$ } from "./external/feature-switch-state.ts";
import { clerk$, clerkUser$ } from "./auth.ts";
import {
  updateUserPreference$,
  userPreferences$,
} from "./okou-page/settings/user-preferences.ts";
import {
  decodeOkouThemePreference,
  encodeOkouThemePreference,
} from "../lib/okou-theme-cookie.ts";
import { onRef } from "./utils.ts";

export type { ColorTheme, ThemePreference };

/**
 * The product's own palette, and the value a workspace starts on. Selecting it
 * is the absence of a preset rather than a ninth one, so the App writes no
 * palette attribute while it is active and every token resolves to the shared
 * values the interface carried before the gradient color themes shipped.
 */
const DEFAULT_COLOR_THEME: ColorTheme = "default";

const internalPreference$ = state<ThemePreference>("system");
const internalResolved$ = state<"light" | "dark">("light");
const internalColorTheme$ = state<ColorTheme>(DEFAULT_COLOR_THEME);
const shellDocumentAttributesMounted$ = state(false);

const {
  get$: themeCookieGet$,
  promoteToSharedDomain$: promoteThemeCookieToSharedDomain$,
  set$: themeCookieSet$,
} = cookieSignals("theme");

/**
 * Current resolved theme value (always "light" or "dark").
 */
export const theme$ = computed((get) => {
  return get(internalResolved$);
});

/**
 * User's theme preference ("light", "dark", or "system").
 */
export const themePreference$ = computed((get) => {
  return get(internalPreference$);
});

/**
 * User's palette-derived workspace color theme.
 */
export const colorTheme$ = computed((get) => {
  return get(internalColorTheme$);
});

/**
 * The palette a themed shell carries, or `undefined` when it carries none.
 * Both the capability being off and the default palette being selected mean
 * no palette attributes, so every shell asks this one question instead of
 * pairing its own feature-switch read with the raw preference.
 */
export const paletteColorTheme$ = computed((get): ColorTheme | undefined => {
  const enabled =
    get(featureSwitchState$)[FeatureSwitchKey.GradientColorThemes] ?? false;
  const colorTheme = get(colorTheme$);
  return enabled && colorTheme !== DEFAULT_COLOR_THEME ? colorTheme : undefined;
});

function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return preference;
}

function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

/**
 * Set theme preference and apply it.
 */
export const setTheme$ = command(({ set }, preference: ThemePreference) => {
  set(internalPreference$, preference);
  const resolved = resolveTheme(preference);
  set(internalResolved$, resolved);
  applyTheme(resolved);
  set(themeCookieSet$, encodeOkouThemePreference(preference));
});

/**
 * Set the palette-derived workspace color theme in memory.
 */
const setColorTheme$ = command(({ set }, colorTheme: ColorTheme) => {
  set(internalColorTheme$, colorTheme);
  set(syncShellDocumentAttributes$);
});

/**
 * Apply a color theme immediately, then persist it when supported by the API.
 */
export const updateColorThemePreference$ = command(
  async ({ set }, colorTheme: ColorTheme, signal: AbortSignal) => {
    set(setColorTheme$, colorTheme);
    await set(updateUserPreference$, { colorTheme }, signal);
  },
);

/**
 * Reconcile the in-memory color theme with the authoritative workspace
 * preference. Light/dark/system stays owned exclusively by the shared cookie.
 */
export const syncColorThemePreference$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const user = await get(clerkUser$);
    signal.throwIfAborted();
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!user || !clerk.organization) {
      return;
    }

    const preferences = await get(userPreferences$);
    signal.throwIfAborted();

    const colorTheme = preferences.colorTheme ?? get(colorTheme$);

    set(setColorTheme$, colorTheme);

    if (preferences.colorTheme === null) {
      await set(updateUserPreference$, { colorTheme }, signal);
    }
  },
);

/**
 * Keep palette theme attributes on the document while a themed app shell is
 * mounted. Document scope lets portaled dialogs and popovers inherit the same
 * semantic tokens as the app shell.
 */
function applyColorThemeDocumentAttributes(colorTheme: ColorTheme | undefined) {
  const root = document.documentElement;

  if (colorTheme === undefined) {
    delete root.dataset.gradientColorThemes;
    delete root.dataset.colorTheme;
    return;
  }

  root.dataset.gradientColorThemes = "";
  root.dataset.colorTheme = colorTheme;
}

/**
 * Project the current shell color theme onto the document. Mount state is owned
 * by the shell ref; semantic setters call this command again when their source
 * state changes without replacing the committed shell element.
 */
export const syncShellDocumentAttributes$ = command(
  ({ get, set }, mounted?: boolean): void => {
    if (mounted !== undefined) {
      set(shellDocumentAttributesMounted$, mounted);
    }

    const shellMounted = get(shellDocumentAttributesMounted$);
    applyColorThemeDocumentAttributes(
      shellMounted ? get(paletteColorTheme$) : undefined,
    );
  },
);

export const shellDocumentAttributesRef$ = onRef(
  command(({ set }, _element: HTMLDivElement, signal: AbortSignal): void => {
    set(syncShellDocumentAttributes$, true);
    signal.addEventListener(
      "abort",
      () => {
        set(syncShellDocumentAttributes$, false);
      },
      { once: true },
    );
  }),
);

/**
 * Initialize theme from the shared cookie or system preference.
 */
export const initTheme$ = command(({ get, set }, signal: AbortSignal) => {
  const preference =
    decodeOkouThemePreference(set(promoteThemeCookieToSharedDomain$)) ??
    "system";
  set(internalPreference$, preference);
  set(internalColorTheme$, DEFAULT_COLOR_THEME);
  const resolved = resolveTheme(preference);
  set(internalResolved$, resolved);
  applyTheme(resolved);
  set(themeCookieSet$, encodeOkouThemePreference(preference));

  // Listen for system theme changes when preference is "system"
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  systemTheme.addEventListener(
    "change",
    () => {
      const currentPreference = get(internalPreference$);
      if (currentPreference === "system") {
        const newResolved = systemTheme.matches ? "dark" : "light";
        set(internalResolved$, newResolved);
        applyTheme(newResolved);
      }
    },
    { signal },
  );

  const syncThemeFromCookie = () => {
    set(refreshCookies$);
    const nextPreference =
      decodeOkouThemePreference(get(themeCookieGet$)) ?? "system";
    set(internalPreference$, nextPreference);
    const nextResolved = resolveTheme(nextPreference);
    set(internalResolved$, nextResolved);
    applyTheme(nextResolved);
  };
  window.addEventListener("focus", syncThemeFromCookie, { signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "visible") {
        syncThemeFromCookie();
      }
    },
    { signal },
  );
});
