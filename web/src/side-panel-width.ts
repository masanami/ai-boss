/**
 * Pure functions for the resizable side panel's width: clamp rules, the
 * pointer-to-width conversion, and localStorage read/write. Kept free of DOM
 * event wiring (that lives in `AppLayout.tsx`; `use-side-panel-width.ts`
 * holds only state and the `resize` subscription) so the clamp math can be
 * unit tested without jsdom's PointerEvent gaps (Issue #362).
 */

export const SIDE_PANEL_MIN_WIDTH = 280;
export const SIDE_PANEL_MAX_WIDTH = 420;
export const SIDE_PANEL_DEFAULT_WIDTH = 280;
export const MAIN_MIN_WIDTH = 480;
export const NAV_WIDTH = 200;
export const SPLITTER_WIDTH = 6;

export const SIDE_PANEL_WIDTH_STORAGE_KEY = "ai-boss:side-panel-width";

/**
 * Clamps a width to the code-configured `[SIDE_PANEL_MIN_WIDTH,
 * SIDE_PANEL_MAX_WIDTH]` bounds only — independent of the current window.
 * Non-finite input is treated as `SIDE_PANEL_DEFAULT_WIDTH` first.
 *
 * This is deliberately separate from `clampSidePanelWidth`: it's used to
 * sanitize the user's *preferred* width before persisting it (in
 * `use-side-panel-width.ts`'s `setWidth`), so a temporarily narrow window
 * never bakes a smaller, window-derived ceiling into the saved preference
 * (feature spec's "保存" — the saved value must be the width the user
 * actually asked for, not whatever the window could currently display).
 */
export function clampToConfiguredBounds(width: number): number {
  const safeWidth = Number.isFinite(width) ? width : SIDE_PANEL_DEFAULT_WIDTH;
  return Math.min(Math.max(safeWidth, SIDE_PANEL_MIN_WIDTH), SIDE_PANEL_MAX_WIDTH);
}

/**
 * Clamps a requested side panel width to `[SIDE_PANEL_MIN_WIDTH, effective
 * max]`, where the effective max accounts for the current window width so
 * the center view never drops below `MAIN_MIN_WIDTH` unless the window is too
 * narrow to honor both constraints — in that case the minimum wins (see the
 * feature spec's "下限と中央最小幅が両立しないウィンドウ幅での優先順位").
 * Used to derive the *displayed* width; see `clampToConfiguredBounds` for the
 * window-independent variant used when persisting a preference.
 */
export function clampSidePanelWidth(
  requestedWidth: number,
  windowWidth: number,
): number {
  const boundedWidth = clampToConfiguredBounds(requestedWidth);
  const effectiveMax = calculateEffectiveMaxWidth(windowWidth);
  return Math.min(boundedWidth, effectiveMax);
}

/**
 * The largest side panel width the current window can actually offer while
 * still reserving `MAIN_MIN_WIDTH` for the center view. When the window is
 * too narrow for both constraints, `SIDE_PANEL_MIN_WIDTH` wins (see the
 * feature spec's "下限と中央最小幅が両立しないウィンドウ幅での優先順位") —
 * shrinking the side panel below its floor would be a regression, whereas the
 * center view can fall back on its own scroll.
 */
export function calculateEffectiveMaxWidth(windowWidth: number): number {
  const availableForSidePanel =
    windowWidth - NAV_WIDTH - SPLITTER_WIDTH - MAIN_MIN_WIDTH;
  return Math.max(
    SIDE_PANEL_MIN_WIDTH,
    Math.min(SIDE_PANEL_MAX_WIDTH, availableForSidePanel),
  );
}

/**
 * Converts a pointer's `clientX` into a clamped side panel width. The side
 * panel's right edge is flush with the window's right edge, so the distance
 * from the pointer to the window's right edge is the requested width — no
 * offset for where inside the splitter the pointer grabbed it, per the
 * feature spec (the correction would be at most `SPLITTER_WIDTH`, smaller
 * than the keyboard step, so it wouldn't be perceptible; KISS). Rounded to a
 * whole pixel since `clientX` can be fractional (browser zoom / sub-pixel
 * device pixel ratios), which would otherwise surface as a fractional
 * `aria-valuenow` and a fractional persisted value.
 *
 * The result is passed straight into `setWidth` (in
 * `use-side-panel-width.ts`) as-is, including while at a window-clamped
 * boundary — `setWidth` itself guards against persisting a value that
 * wouldn't change what's displayed, so drag doesn't need a separate
 * unclamped variant of this function (see that guard's doc comment for the
 * two review-round bugs it fixes).
 */
export function widthFromPointerX(clientX: number, windowWidth: number): number {
  return clampSidePanelWidth(Math.round(windowWidth - clientX), windowWidth);
}

/**
 * Reads the persisted side panel width as a raw preference, ignoring the
 * current window entirely (only the code-configured `[MIN, MAX]` bounds are
 * applied — see `clampToConfiguredBounds`). Falls back to
 * `SIDE_PANEL_DEFAULT_WIDTH` when the key is missing, the stored value is an
 * empty/whitespace string or otherwise not a finite number, or `localStorage`
 * access itself throws (private browsing / storage disabled).
 *
 * This is the source of truth the hook seeds its in-memory preference state
 * from on mount; from then on, `resize` only updates the window width (see
 * `use-side-panel-width.ts`), never re-reads storage — so narrowing and then
 * widening the window recovers the original preference instead of getting
 * stuck at a previous, narrower clamp.
 */
export function readStoredPreferredWidth(): number {
  let rawValue: string | null;
  try {
    rawValue = localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY);
  } catch {
    rawValue = null;
  }
  if (rawValue === null || rawValue.trim() === "") {
    return SIDE_PANEL_DEFAULT_WIDTH;
  }
  const parsedWidth = Number(rawValue);
  if (!Number.isFinite(parsedWidth)) {
    return SIDE_PANEL_DEFAULT_WIDTH;
  }
  return clampToConfiguredBounds(parsedWidth);
}

/**
 * Reads the persisted side panel width, clamped for display against the
 * given window width — i.e. `clampSidePanelWidth(readStoredPreferredWidth(),
 * windowWidth)`, which is also exactly what the hook derives its `width`
 * from each render (once seeded from `readStoredPreferredWidth` at mount).
 * Exported as its own tested unit so "read + clamp for display" has a
 * dedicated regression test independent of mounting the component.
 */
export function readStoredSidePanelWidth(windowWidth: number): number {
  return clampSidePanelWidth(readStoredPreferredWidth(), windowWidth);
}

/**
 * Persists the side panel width as the user's requested width. Swallows
 * write failures (e.g. quota exceeded, storage disabled) so the UI keeps
 * working even though the change won't survive a reload.
 */
export function writeStoredSidePanelWidth(width: number): void {
  try {
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Intentionally ignored: width changes still apply in-memory.
  }
}
