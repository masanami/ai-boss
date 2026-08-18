import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Reads the real web/public/ assets directly (not a synthetic fixture) so a
// favicon.svg/manifest.webmanifest content regression is caught even though
// web/index.html's link tags themselves are out of scope for unit testing
// (Issue #156). This lives in the web workspace (not server/) because
// web/public/ is a web-owned source directory; server only has a contract
// with the built web/dist/ output (see server/src/index.ts's webDistPath),
// never with web's source tree directly.
//
// process.cwd() (not import.meta.url) is used to locate web/public/:
// `fileURLToPath(new URL(...))` throws "The URL must be of scheme file" here
// because this project's vitest config runs tests under environment: jsdom,
// whose global `URL` class (not Node's `node:url`) is what `new URL()`
// resolves to in this file — even though import.meta.url itself is a valid
// file:// string. Vitest runs with cwd set to the web/ workspace root (both
// `npm run test --workspace web` and the root `npm run test` orchestrator
// preserve that), so process.cwd() is the reliable choice here.
const publicDir = join(process.cwd(), "public");

describe("web/public assets", () => {
  it("favicon.svg is a valid SVG image", () => {
    const svg = readFileSync(join(publicDir, "favicon.svg"), "utf-8");

    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("manifest.webmanifest declares a standalone app with 192px/512px PNG icons", () => {
    const manifestJson = readFileSync(join(publicDir, "manifest.webmanifest"), "utf-8");
    const manifest = JSON.parse(manifestJson) as {
      name: string;
      display: string;
      theme_color: string;
      icons: { src: string; sizes: string; type: string }[];
    };

    expect(manifest.name).toBe("ai-boss");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/icon-192.png", sizes: "192x192", type: "image/png" }),
        expect.objectContaining({ src: "/icon-512.png", sizes: "512x512", type: "image/png" }),
      ]),
    );
  });

  // PNG generation (qlmanage/sips) was blocked by the permission system during
  // implementation (Issue #156); the lead generates icon-192.png/icon-512.png
  // separately. This it.todo is a deliberate, visible marker (rather than a
  // silently-passing assertion) so the gap doesn't disappear from test output:
  // once the PNGs land, replace this with a real existsSync + pixel-size
  // assertion for both files.
  it.todo(
    "icon-192.png and icon-512.png referenced by manifest.webmanifest exist as 192x192/512x512 PNGs (blocked: PNG generation commands denied by permission system, see Issue #156)",
  );
});
