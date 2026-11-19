import { command, computed, state } from "ccstate";
import type { ThemePreference } from "@okouai/api-contracts/contracts/user-preferences";
import {
  COLOR_THEMES,
  type ColorTheme,
} from "@okouai/api-contracts/validators/user-preferences";
import { cookieSignals, refreshCookies$ } from "./external/cookie.ts";
import { authenticatedSessionKey$, clerk$, clerkUser$ } from "./auth.ts";
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
 * is the absence of a preset rather than another one, so the App writes no
 * palette attribute while it is active and every token resolves to the shared
 * values the interface carried before the gradient color themes shipped.
 */
const DEFAULT_COLOR_THEME: ColorTheme = "default";

const internalPreference$ = state<ThemePreference>("system");
const internalResolved$ = state<"light" | "dark">("light");
const internalColorTheme$ = state<ColorTheme>(DEFAULT_COLOR_THEME);
const workspaceThemeChosen$ = state(false);
const workspaceColorThemeChosen$ = state(false);
const shellDocumentAttributesMounted$ = state(false);

const {
  get$: themeCookieGet$,
  readFresh$: themeCookieReadFresh$,
  promoteToSharedDomain$: promoteThemeCookieToSharedDomain$,
  set$: themeCookieSet$,
} = cookieSignals("theme");

const {
  get$: colorThemeCookieGet$,
  readFresh$: colorThemeCookieReadFresh$,
  set$: colorThemeCookieSet$,
  clear$: colorThemeCookieClear$,
} = cookieSignals("color-theme", { scope: "host" });

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
 * The default palette being selected means no palette attributes, so every
 * shell asks this one question instead of comparing the raw preference itself.
 */
export const paletteColorTheme$ = computed((get): ColorTheme | undefined => {
  const colorTheme = get(colorTheme$);
  return colorTheme !== DEFAULT_COLOR_THEME ? colorTheme : undefined;
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

const applyThemePreference$ = command(
  ({ set }, preference: ThemePreference) => {
    set(internalPreference$, preference);
    const resolved = resolveTheme(preference);
    set(internalResolved$, resolved);
    applyTheme(resolved);
  },
);

const cacheThemePreference$ = command(
  ({ set }, preference: ThemePreference) => {
    const value = encodeOkouThemePreference(preference);
    if (set(themeCookieReadFresh$) !== value) {
      set(themeCookieSet$, value);
    }
  },
);

/** Apply a local appearance choice from the sign-in or error screen. */
export const setTheme$ = command(({ set }, preference: ThemePreference) => {
  set(applyThemePreference$, preference);
  set(cacheThemePreference$, preference);
});

/**
 * Apply a member's theme choice locally, then save it to their workspace.
 */
export const updateThemePreference$ = command(
  async ({ set }, theme: ThemePreference, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(workspaceThemeChosen$, true);
    set(applyThemePreference$, theme);
    await set(updateUserPreference$, { theme }, signal);
    signal.throwIfAborted();
    set(cacheThemePreference$, theme);
  },
);

/**
 * Set the palette-derived workspace color theme in memory.
 */
const setColorTheme$ = command(({ set }, colorTheme: ColorTheme) => {
  set(internalColorTheme$, colorTheme);
  set(syncShellDocumentAttributes$);
});

const cacheColorTheme$ = command(({ set }, colorTheme: ColorTheme) => {
  const cached = set(colorThemeCookieReadFresh$);
  if (colorTheme === DEFAULT_COLOR_THEME) {
    if (cached !== null) {
      set(colorThemeCookieClear$);
    }
  } else if (cached !== colorTheme) {
    set(colorThemeCookieSet$, colorTheme);
  }
});

/** Apply a member's palette locally, then save it to their workspace. */
export const updateColorThemePreference$ = command(
  async ({ set }, colorTheme: ColorTheme, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(workspaceColorThemeChosen$, true);
    set(setColorTheme$, colorTheme);
    await set(updateUserPreference$, { colorTheme }, signal);
    signal.throwIfAborted();
    set(cacheColorTheme$, colorTheme);
  },
);

/**
 * Apply the active member's shared appearance and palette once their workspace
 * preferences have loaded. Cookies seed the first paint and are reconciled
 * to the workspace values. Defaults never write back to the workspace.
 */
export const syncThemePreferences$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const user = await get(clerkUser$);
    signal.throwIfAborted();
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const workspaceId = clerk.organization?.id;
    if (!user || !workspaceId) {
      return;
    }

    const preferences = await get(userPreferences$);
    signal.throwIfAborted();
    if (clerk.organization?.id !== workspaceId || clerk.user?.id !== user.id) {
      return;
    }

    // A choice made while startup was loading belongs to the current session.
    if (!get(workspaceThemeChosen$)) {
      const theme = preferences.theme ?? "system";
      set(applyThemePreference$, theme);
      set(cacheThemePreference$, theme);
    }
    if (!get(workspaceColorThemeChosen$)) {
      const colorTheme = preferences.colorTheme ?? DEFAULT_COLOR_THEME;
      set(setColorTheme$, colorTheme);
      set(cacheColorTheme$, colorTheme);
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
 * Project the current shell color theme onto the document.
 * Mount state is owned by the shell ref; semantic setters call this command
 * again when their source state changes without replacing the shell element.
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
 * Seed appearance and the first app shell palette before workspace IO.
 */
export const initTheme$ = command(({ get, set }, signal: AbortSignal) => {
  const preference =
    decodeOkouThemePreference(set(promoteThemeCookieToSharedDomain$)) ??
    "system";
  set(workspaceThemeChosen$, false);
  set(workspaceColorThemeChosen$, false);
  set(applyThemePreference$, preference);
  const cachedPalette = get(colorThemeCookieGet$);
  set(
    internalColorTheme$,
    COLOR_THEMES.find((palette) => {
      return palette === cachedPalette;
    }) ?? DEFAULT_COLOR_THEME,
  );
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
    // The shared cookie can be updated by a different account or workspace.
    if (get(authenticatedSessionKey$)) {
      return;
    }
    set(refreshCookies$);
    set(
      applyThemePreference$,
      decodeOkouThemePreference(get(themeCookieGet$)) ?? "system",
    );
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
