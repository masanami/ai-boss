import { describe, expect, it } from "vitest";
import {
  isAllowedEvidenceExtension,
  isAllowedEvidenceUrlScheme,
  isEvidenceCountUnderLimit,
  isEvidenceFileSizeAllowed,
  resolveEvidenceMimeType,
} from "./evidence-validation.js";
import { MAX_EVIDENCES_PER_TASK, MAX_EVIDENCE_FILE_BYTES } from "./task-evidence.js";

describe("isAllowedEvidenceExtension", () => {
  it("allows a whitelisted extension", () => {
    expect(isAllowedEvidenceExtension("screenshot.png")).toBe(true);
  });

  it("is case-insensitive (uppercase extension is allowed, AC)", () => {
    expect(isAllowedEvidenceExtension("SCREENSHOT.PNG")).toBe(true);
  });

  it.each(["evil.exe", "run.sh", "Installer.app", "run.command", "script.scpt"])(
    "rejects the executable filename %s",
    (filename) => {
      expect(isAllowedEvidenceExtension(filename)).toBe(false);
    },
  );

  it.each(["image.svg", "page.html"])(
    "rejects the active-content filename %s even though it looks like a document type",
    (filename) => {
      expect(isAllowedEvidenceExtension(filename)).toBe(false);
    },
  );

  it("rejects a filename with no extension", () => {
    expect(isAllowedEvidenceExtension("README")).toBe(false);
  });

  it("is safe against a path-traversal filename (extension is still read from the trailing component)", () => {
    expect(isAllowedEvidenceExtension("../../etc/passwd.png")).toBe(true);
    expect(isAllowedEvidenceExtension("../../etc/passwd.exe")).toBe(false);
  });
});

describe("resolveEvidenceMimeType", () => {
  it("resolves the MIME type for an allowed extension", () => {
    expect(resolveEvidenceMimeType("report.pdf")).toBe("application/pdf");
  });

  it("is case-insensitive", () => {
    expect(resolveEvidenceMimeType("REPORT.PDF")).toBe("application/pdf");
  });

  it("returns undefined for a disallowed extension", () => {
    expect(resolveEvidenceMimeType("evil.exe")).toBeUndefined();
  });
});

describe("isEvidenceFileSizeAllowed", () => {
  it("allows a size well under the limit", () => {
    expect(isEvidenceFileSizeAllowed(1024)).toBe(true);
  });

  it("allows a size exactly at the limit (boundary: <=, not <)", () => {
    expect(isEvidenceFileSizeAllowed(MAX_EVIDENCE_FILE_BYTES)).toBe(true);
  });

  it("rejects a size 1 byte over the limit (boundary: not >=)", () => {
    expect(isEvidenceFileSizeAllowed(MAX_EVIDENCE_FILE_BYTES + 1)).toBe(false);
  });

  it("rejects a size well over the limit", () => {
    expect(isEvidenceFileSizeAllowed(MAX_EVIDENCE_FILE_BYTES * 2)).toBe(false);
  });
});

describe("isEvidenceCountUnderLimit", () => {
  it("allows adding when the current count is well under the limit", () => {
    expect(isEvidenceCountUnderLimit(0)).toBe(true);
  });

  it("allows adding when the current count is exactly one below the limit (boundary)", () => {
    expect(isEvidenceCountUnderLimit(MAX_EVIDENCES_PER_TASK - 1)).toBe(true);
  });

  it("rejects adding when the current count is already at the limit (boundary: not <=)", () => {
    expect(isEvidenceCountUnderLimit(MAX_EVIDENCES_PER_TASK)).toBe(false);
  });

  it("rejects adding when the current count is already over the limit", () => {
    expect(isEvidenceCountUnderLimit(MAX_EVIDENCES_PER_TASK + 5)).toBe(false);
  });
});

describe("isAllowedEvidenceUrlScheme", () => {
  it("allows https", () => {
    expect(isAllowedEvidenceUrlScheme("https://example.com/report")).toBe(true);
  });

  it("allows http", () => {
    expect(isAllowedEvidenceUrlScheme("http://example.com/report")).toBe(true);
  });

  it("rejects the file: scheme", () => {
    expect(isAllowedEvidenceUrlScheme("file:///etc/passwd")).toBe(false);
  });

  it("rejects the javascript: scheme", () => {
    expect(isAllowedEvidenceUrlScheme("javascript:alert(1)")).toBe(false);
  });

  it("rejects a malformed URL string without throwing", () => {
    expect(isAllowedEvidenceUrlScheme("not a url")).toBe(false);
  });
});
