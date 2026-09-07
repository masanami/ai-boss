import { describe, expect, it } from "vitest";
import {
  ALLOWED_EVIDENCE_EXTENSIONS,
  EVIDENCE_EXTENSION_MIME_TYPES,
  EVIDENCE_KINDS,
  MAX_EVIDENCES_PER_TASK,
  MAX_EVIDENCE_FILE_BYTES,
} from "./task-evidence.js";

// エビデンス強制（#256 決定 1-c / #387）: 拡張子ホワイトリストと MIME 導出の
// 単一の情報源（機能仕様の表そのもの）を固定するテスト。

describe("EVIDENCE_KINDS", () => {
  it("is exactly ['file', 'link']", () => {
    expect(EVIDENCE_KINDS).toEqual(["file", "link"]);
  });
});

describe("MAX_EVIDENCE_FILE_BYTES / MAX_EVIDENCES_PER_TASK", () => {
  it("caps a single file at 10 MB", () => {
    expect(MAX_EVIDENCE_FILE_BYTES).toBe(10 * 1024 * 1024);
  });

  it("caps a task at 10 evidences", () => {
    expect(MAX_EVIDENCES_PER_TASK).toBe(10);
  });
});

describe("ALLOWED_EVIDENCE_EXTENSIONS", () => {
  const expectedAllowed = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".heic",
    ".pdf",
    ".txt",
    ".log",
    ".md",
    ".csv",
    ".json",
    ".docx",
    ".xlsx",
    ".pptx",
  ];

  it("contains exactly the extensions from the whitelist table (機能仕様 決定 1-c)", () => {
    expect([...ALLOWED_EVIDENCE_EXTENSIONS].sort()).toEqual([...expectedAllowed].sort());
  });

  it.each([".exe", ".sh", ".app", ".command", ".scpt", ".bat", ".ps1", ".jar", ".pkg", ".dmg"])(
    "excludes the executable extension %s",
    (ext) => {
      expect(ALLOWED_EVIDENCE_EXTENSIONS).not.toContain(ext);
    },
  );

  it.each([".html", ".htm", ".svg", ".xhtml"])(
    "excludes the active-content extension %s (including .svg, which is otherwise an image)",
    (ext) => {
      expect(ALLOWED_EVIDENCE_EXTENSIONS).not.toContain(ext);
    },
  );
});

describe("EVIDENCE_EXTENSION_MIME_TYPES", () => {
  it.each([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".gif", "image/gif"],
    [".webp", "image/webp"],
    [".heic", "image/heic"],
    [".pdf", "application/pdf"],
    [".txt", "text/plain"],
    [".log", "text/plain"],
    [".md", "text/markdown"],
    [".csv", "text/csv"],
    [".json", "application/json"],
    [
      ".docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    [
      ".pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  ])("maps %s to %s (機能仕様 決定 1-c の表が単一の情報源)", (ext, mime) => {
    expect(EVIDENCE_EXTENSION_MIME_TYPES[ext]).toBe(mime);
  });

  it("has exactly one entry per allowed extension (no drift between the whitelist and the MIME map)", () => {
    expect(Object.keys(EVIDENCE_EXTENSION_MIME_TYPES).sort()).toEqual(
      [...ALLOWED_EVIDENCE_EXTENSIONS].sort(),
    );
  });
});
