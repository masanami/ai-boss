import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateEffectiveMaxWidth,
  clampSidePanelWidth,
  clampToConfiguredBounds,
  readStoredPreferredWidth,
  readStoredSidePanelWidth,
  SIDE_PANEL_MAX_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  SIDE_PANEL_WIDTH_STORAGE_KEY,
  widthFromPointerX,
  writeStoredSidePanelWidth,
} from "./side-panel-width";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("clampSidePanelWidth", () => {
  it("clamps a request below the minimum up to 280 (window wide enough)", () => {
    expect(clampSidePanelWidth(100, 1200)).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("clamps a request above the maximum down to 420 (window wide enough)", () => {
    expect(clampSidePanelWidth(1000, 1200)).toBe(SIDE_PANEL_MAX_WIDTH);
  });

  it("returns the request unchanged when it equals the minimum exactly (boundary)", () => {
    expect(clampSidePanelWidth(280, 1200)).toBe(280);
  });

  it("returns the request unchanged when it equals the maximum exactly (boundary)", () => {
    expect(clampSidePanelWidth(420, 1200)).toBe(420);
  });

  it("clamps to the window-derived effective max when the window is too narrow for 420 (W - 200 - 6 - 480 < 420)", () => {
    // W=1000: 1000 - 200 - 6 - 480 = 314, below both the request and 420.
    expect(clampSidePanelWidth(420, 1000)).toBe(314);
  });

  it("falls back to the minimum when the window is too narrow to honor both the minimum and MAIN_MIN_WIDTH", () => {
    // W=800: 800 - 200 - 6 - 480 = 114, below SIDE_PANEL_MIN_WIDTH (280).
    // The spec requires the minimum to win over the center's MAIN_MIN_WIDTH.
    expect(clampSidePanelWidth(300, 800)).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("treats a non-finite requested width as the default width before clamping", () => {
    expect(clampSidePanelWidth(NaN, 1200)).toBe(280);
    expect(clampSidePanelWidth(Infinity, 1200)).toBe(280);
  });
});

describe("calculateEffectiveMaxWidth", () => {
  it("returns 420 when the window is wide enough to afford the full max", () => {
    expect(calculateEffectiveMaxWidth(1200)).toBe(SIDE_PANEL_MAX_WIDTH);
  });

  it("returns a window-derived value below 420 when the window is narrower", () => {
    // W=1000: 1000 - 200 - 6 - 480 = 314.
    expect(calculateEffectiveMaxWidth(1000)).toBe(314);
  });

  it("returns the minimum (280) when the window is too narrow to afford it via the formula", () => {
    // W=800: 800 - 200 - 6 - 480 = 114, below SIDE_PANEL_MIN_WIDTH.
    expect(calculateEffectiveMaxWidth(800)).toBe(SIDE_PANEL_MIN_WIDTH);
  });
});

describe("widthFromPointerX", () => {
  it("converts a pointer clientX into the clamped distance from the window's right edge", () => {
    // windowWidth=1200, clientX=900 -> requested 300, within [280, 420].
    expect(widthFromPointerX(900, 1200)).toBe(300);
  });

  it("clamps the resulting width when the pointer is dragged past the minimum", () => {
    // windowWidth=1200, clientX=1190 -> requested 10, clamped up to 280.
    expect(widthFromPointerX(1190, 1200)).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("clamps the resulting width when the pointer is dragged past the maximum", () => {
    // windowWidth=1200, clientX=100 -> requested 1100, clamped down to 420.
    expect(widthFromPointerX(100, 1200)).toBe(SIDE_PANEL_MAX_WIDTH);
  });

  it("rounds a fractional clientX (sub-pixel pointer position) to a whole-pixel width", () => {
    // windowWidth=1200, clientX=900.4 -> requested 299.6, rounds to 300
    // (within [280, 420], so the assertion isolates rounding from clamping).
    expect(widthFromPointerX(900.4, 1200)).toBe(300);
  });
});

describe("clampToConfiguredBounds", () => {
  // Unlike clampSidePanelWidth, this ignores the window entirely and only
  // enforces the code-level [SIDE_PANEL_MIN_WIDTH, SIDE_PANEL_MAX_WIDTH]
  // bounds. It exists so a user's *preference* can be sanitized before being
  // persisted without baking in a possibly-temporary window-derived ceiling
  // (see setWidth in use-side-panel-width.ts / Issue #362 review finding).
  it("passes an in-range value through unchanged", () => {
    expect(clampToConfiguredBounds(350)).toBe(350);
  });

  it("clamps a value below the minimum up to 280", () => {
    expect(clampToConfiguredBounds(10)).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("clamps a value above the maximum down to 420", () => {
    expect(clampToConfiguredBounds(9999)).toBe(SIDE_PANEL_MAX_WIDTH);
  });

  it("treats a non-finite value as the default width before clamping", () => {
    expect(clampToConfiguredBounds(NaN)).toBe(280);
  });

  it("is not affected by window width (unlike clampSidePanelWidth)", () => {
    // A request of 420 is within the configured max regardless of how
    // narrow the window is; only clampSidePanelWidth would lower it further.
    expect(clampToConfiguredBounds(420)).toBe(420);
    expect(clampSidePanelWidth(420, 800)).toBe(SIDE_PANEL_MIN_WIDTH);
  });
});

describe("readStoredSidePanelWidth", () => {
  it("returns the stored value, clamped, when it is a valid number within range", () => {
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "320");
    expect(readStoredSidePanelWidth(1200)).toBe(320);
  });

  it("returns the default (280) when no key is stored", () => {
    expect(readStoredSidePanelWidth(1200)).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("returns the default (280) when the stored value is not a finite number", () => {
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "abc");
    expect(readStoredSidePanelWidth(1200)).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("returns the default (280) when the stored value is an empty string", () => {
    // Number("") is 0 (a finite number) in JS, but the spec explicitly lists
    // "" among the values that must be treated as unparseable, not as 0.
    // Note: because SIDE_PANEL_DEFAULT_WIDTH === SIDE_PANEL_MIN_WIDTH (both
    // 280), this particular assertion can't observationally distinguish
    // "treated as invalid -> defaulted" from "misread as 0 -> floored to the
    // minimum" -- both produce 280 here. See the dedicated
    // readStoredPreferredWidth "" test below, which exercises the
    // window-independent function directly and documents the same caveat.
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "");
    expect(readStoredSidePanelWidth(1200)).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("returns the default (280) when the stored value is the literal string 'NaN'", () => {
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "NaN");
    expect(readStoredSidePanelWidth(1200)).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("returns the default (280) when the stored value is the literal string 'Infinity'", () => {
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "Infinity");
    expect(readStoredSidePanelWidth(1200)).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("clamps an out-of-range stored value instead of discarding it", () => {
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "9999");
    expect(readStoredSidePanelWidth(1200)).toBe(SIDE_PANEL_MAX_WIDTH);
  });

  it("returns the default (280) when localStorage.getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    expect(readStoredSidePanelWidth(1200)).toBe(SIDE_PANEL_MIN_WIDTH);
  });
});

describe("readStoredPreferredWidth", () => {
  // Unlike readStoredSidePanelWidth, this does not take a windowWidth and
  // never applies the window-derived effective max -- it's the "raw user
  // preference" used to seed/refresh the hook's in-memory desired width, so
  // a temporary narrow window never permanently overwrites what's in
  // localStorage (Issue #362 review finding: setWidth used to persist the
  // window-clamped display value instead of this).
  it("returns the stored value, clamped only to the configured [280,420] bounds", () => {
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "320");
    expect(readStoredPreferredWidth()).toBe(320);
  });

  it("returns the default (280) when no key is stored", () => {
    expect(readStoredPreferredWidth()).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("returns the default (280) when the stored value is not a finite number", () => {
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "abc");
    expect(readStoredPreferredWidth()).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("returns the default (280) when the stored value is an empty string", () => {
    // Same coincidental-280 caveat as the readStoredSidePanelWidth "" test
    // above: SIDE_PANEL_DEFAULT_WIDTH === SIDE_PANEL_MIN_WIDTH today, so this
    // can't observationally prove "" took the invalid->default path rather
    // than a hypothetical 0->floored-to-min path. It still pins down the
    // required observable behavior (280) as a regression guard.
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "");
    expect(readStoredPreferredWidth()).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("clamps an out-of-range stored value to the configured max instead of discarding it", () => {
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "9999");
    expect(readStoredPreferredWidth()).toBe(SIDE_PANEL_MAX_WIDTH);
  });

  it("does not apply a window-derived ceiling (unlike readStoredSidePanelWidth)", () => {
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "420");
    expect(readStoredPreferredWidth()).toBe(420);
    // The same stored value, read through the window-aware function at a
    // narrow window, would come back lower -- proving the two functions
    // genuinely differ rather than one being a trivial alias of the other.
    expect(readStoredSidePanelWidth(800)).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("returns the default (280) when localStorage.getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    expect(readStoredPreferredWidth()).toBe(SIDE_PANEL_MIN_WIDTH);
  });
});

describe("writeStoredSidePanelWidth", () => {
  it("saves the width as a decimal string under the side panel width key", () => {
    writeStoredSidePanelWidth(360);
    expect(localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY)).toBe("360");
  });

  it("does not throw when localStorage.setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => writeStoredSidePanelWidth(360)).not.toThrow();
  });
});
