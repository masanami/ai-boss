import { useCallback, useEffect, useState } from "react";
import {
  calculateEffectiveMaxWidth,
  clampSidePanelWidth,
  clampToConfiguredBounds,
  readStoredPreferredWidth,
  writeStoredSidePanelWidth,
} from "./side-panel-width";

export interface SidePanelWidthState {
  /** The width to render the side panel at right now (already clamped). */
  width: number;
  /** The largest width the current window can offer (for `aria-valuemax`). */
  effectiveMax: number;
  /**
   * The current window width, exposed so callers (e.g. a pointer-drag
   * handler in AppLayout.tsx) don't need to read `window.innerWidth`
   * directly and risk it disagreeing with what this hook used to derive
   * `width`/`effectiveMax` for the same render.
   */
  windowWidth: number;
  /**
   * Applies a user-requested width (from a drag or keyboard action):
   * updates the rendered width and persists the request as the user's
   * preference, *unless* the request wouldn't visibly change `width` (see
   * this function's doc comment below for why that guard matters).
   */
  setWidth: (requestedWidth: number) => void;
}

/**
 * Owns the side panel's width: restores the user's preference from
 * `localStorage` on mount, re-derives the *displayed* width whenever the
 * window resizes (without persisting), and persists user-driven changes
 * made via `setWidth`.
 *
 * The raw preference (`preferredWidth`, sanitized only to the
 * code-configured `[MIN, MAX]` bounds — see `clampToConfiguredBounds`) and
 * the window width are tracked separately and combined only at render time:
 * `width` is always `clampSidePanelWidth(preferredWidth, windowWidth)`,
 * never the other way around. `resize` only updates `windowWidth`, so
 * narrowing and then widening the window recovers the original preference
 * instead of getting stuck at whatever a previous, narrower render clamped
 * it to (Issue #362 / feature spec "保存").
 *
 * `setWidth` additionally skips persisting when the request wouldn't
 * actually change what's displayed (`clampSidePanelWidth(requestedWidth,
 * windowWidth) === width`). Two independent code review rounds on Issue
 * #362 found real bugs from *not* having this guard, both from the same
 * root cause (a request whose window-clamped display value doesn't move is
 * treated as meaningful anyway):
 *
 * - Pressing the widen key while already pinned at the window's temporary
 *   ceiling has no visible effect, but persisting that ceiling anyway
 *   silently overwrote a higher saved preference (e.g. 420 -> 314) — so
 *   widening the window back out no longer recovered it.
 * - Home/End and the narrow key are also window-derived at the boundary
 *   (End literally requests the *current* effective max), so the same
 *   ceiling-persisting bug applied to them too once the widen key was
 *   special-cased instead of guarding `setWidth` itself.
 *
 * Guarding on "did the display actually change" (rather than routing the
 * widen key through the raw preference, which was an earlier, asymmetric
 * attempt at this fix) keeps all four keys and the pointer drag on one
 * rule: a request only becomes the new preference when it's a real,
 * observable change, so it can never touch a preference that's currently
 * "hidden" behind a narrower window without the user actually asking to
 * shrink past what they can currently see.
 */
export function useSidePanelWidth(): SidePanelWidthState {
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [preferredWidth, setPreferredWidth] = useState(() =>
    readStoredPreferredWidth(),
  );
  const width = clampSidePanelWidth(preferredWidth, windowWidth);

  useEffect(() => {
    function handleResize() {
      setWindowWidth(window.innerWidth);
    }

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  const setWidth = useCallback(
    (requestedWidth: number) => {
      const nextWidth = clampSidePanelWidth(requestedWidth, windowWidth);
      if (nextWidth === width) {
        return;
      }
      const nextPreferredWidth = clampToConfiguredBounds(requestedWidth);
      setPreferredWidth(nextPreferredWidth);
      writeStoredSidePanelWidth(nextPreferredWidth);
    },
    [width, windowWidth],
  );

  return {
    width,
    effectiveMax: calculateEffectiveMaxWidth(windowWidth),
    windowWidth,
    setWidth,
  };
}
