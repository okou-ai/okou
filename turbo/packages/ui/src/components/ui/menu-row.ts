/**
 * The app's 36px popup-list row, shared by `DropdownMenuItem`,
 * `DropdownMenuSubTrigger` and `SelectItem`. It is the same height `Button`
 * ships as its default size and `IconButton` ships as its square.
 *
 * Hand-rolling it at the call site is what left the composer's `+` menu at
 * 32px, the account and workspace menus at 40px, the subscriptions reset action
 * at 28px, and the model picker beside them at 36px.
 *
 * A floor rather than `h-9`, so a row whose label wraps or whose child is
 * taller than the line box grows instead of clipping. A floor rather than
 * padding alone, because padding sets the height only in terms of the line box:
 * one caller passing `text-xs` would quietly draw a 32px row and the menu would
 * fork again. `py-1.5` is what the row breathes by once it does exceed 36px.
 *
 * It lives here rather than on one of the three components so the number has a
 * single owner; `ccstate/menu-row-height` holds the call sites to the same rule.
 */
export const MENU_ROW_HEIGHT_CLASS = "min-h-9 py-1.5 text-sm";
