import { describe, expect, it } from "vitest";

import { stripHtmlTags, splitPendingTagTail } from "./strip-html-tags.js";

const BLOCK_TAGS = [
  "br",
  "p",
  "div",
  "li",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
  "hr",
  "table",
  "blockquote",
  "pre",
];

const INLINE_TAGS = ["strong", "em", "b", "i", "span", "code", "a", "td", "th"];

describe("stripHtmlTags", () => {
  it("replaces a block-boundary tag with a single newline (AC-1)", () => {
    expect(stripHtmlTags("<br>")).toBe("\n");
  });

  it("replaces every block-boundary tag in every form with a single newline (AC-1)", () => {
    for (const tag of BLOCK_TAGS) {
      expect(stripHtmlTags(`<${tag}>`), `<${tag}>`).toBe("\n");
      expect(stripHtmlTags(`</${tag}>`), `</${tag}>`).toBe("\n");
      expect(stripHtmlTags(`<${tag}/>`), `<${tag}/>`).toBe("\n");
      expect(stripHtmlTags(`<${tag} />`), `<${tag} />`).toBe("\n");
    }
  });

  it("removes every inline tag in every form (AC-2)", () => {
    for (const tag of INLINE_TAGS) {
      expect(stripHtmlTags(`<${tag}>`), `<${tag}>`).toBe("");
      expect(stripHtmlTags(`</${tag}>`), `</${tag}>`).toBe("");
      expect(stripHtmlTags(`<${tag}/>`), `<${tag}/>`).toBe("");
      expect(stripHtmlTags(`<${tag} />`), `<${tag} />`).toBe("");
    }
  });

  it("replaces a block-boundary tag with attributes with a single newline (AC-3)", () => {
    expect(stripHtmlTags('<p class="x">')).toBe("\n");
    expect(stripHtmlTags('<div id="a">')).toBe("\n");
  });

  it("removes an inline tag with attributes (AC-4)", () => {
    expect(stripHtmlTags('<a href="https://example.com">')).toBe("");
    expect(stripHtmlTags('<span class="x">')).toBe("");
  });

  // レビュー指摘: 属性部の走査が改行を跨ぐと、`<div` のようにタグ名の後ろに
  // 改行が続く形が正当な文章に現れたとき、次に見つかる `>` までの複数行を
  // 丸ごと飲み込んでしまう。タグは単一行に閉じていなければならないとして
  // 防ぐ（属性が複数行にまたがる入力は現実的に無い）。
  it("never matches across a line break, even when a later line happens to contain '>'", () => {
    expect(stripHtmlTags("行1 <div\n行2\n行3> 行4")).toBe(
      "行1 <div\n行2\n行3> 行4",
    );
    expect(stripHtmlTags("説明<span\n本文が続く 5 > 3 終わり")).toBe(
      "説明<span\n本文が続く 5 > 3 終わり",
    );
  });

  it("leaves tag names not on the allowlist unchanged (AC-5)", () => {
    expect(stripHtmlTags("<foo>")).toBe("<foo>");
    expect(stripHtmlTags('<foo bar="1">')).toBe('<foo bar="1">');
  });

  it("leaves tag names containing uppercase letters unchanged (AC-6)", () => {
    for (const input of ["<P>", "<BR>", "<A>", "<Br>"]) {
      expect(stripHtmlTags(input), input).toBe(input);
    }
  });

  it("returns the input unchanged when there is no allowlisted tag match (AC-7)", () => {
    for (const input of [
      "x < 10 のとき",
      "<タスク名> の形式で書け",
      "a <= 3",
      "今日もお疲れさま🎉",
    ]) {
      expect(stripHtmlTags(input), input).toBe(input);
    }
  });

  it("leaves Markdown notation unchanged (AC-8)", () => {
    for (const input of ["**強調**", "- 箇条書き", "1. 番号付きリスト"]) {
      expect(stripHtmlTags(input), input).toBe(input);
    }
  });

  it("does not trim the result (AC-9)", () => {
    expect(stripHtmlTags("<p>甲</p>")).toBe("\n甲\n");
  });

  it("does not collapse consecutive newlines (AC-10)", () => {
    expect(stripHtmlTags("<p>甲</p><p>乙</p>")).toBe("\n甲\n\n乙\n");
  });

  // 既知の限界（ファイル冒頭コメント参照）: `<` ＋ 単文字タグ名 ＋ `>` の形は
  // 正当な文章に現れても除去される。この損失は意図的に受け入れたものであり、
  // 「バグ」として静かに挙動が変わらないようテストで固定する。
  it("removes a single-letter tag name even when it appears in ordinary prose (accepted known limitation)", () => {
    expect(stripHtmlTags("a<b>c")).toBe("ac");
  });

  // 既知の限界（ファイル冒頭コメント参照）: 属性値の中に文字として `>` が
  // 含まれる不正な形は、属性走査がその `>` で止まり、以降が地の文として残る。
  it("stops attribute scanning at the first '>', even inside a malformed attribute value (accepted known limitation)", () => {
    expect(stripHtmlTags('<a href="a>b">text</a>')).toBe('b">text');
  });

  it("keeps the prefix's normalized result as a prefix of the whole's normalized result when the split does not fall inside a tag", () => {
    // 先頭に空白を置くのは、「入力全体でタグが1つでも見つかったか」という
    // 大域条件で発火する変換（例: 一致があれば結果をtrimする）を検出するため。
    // そのような変換は、タグより前で区切った接頭辞（まだタグに一致していない）
    // では発火せず、全体（タグに一致する）では発火するため、この境界だけが
    // 非単調性を暴ける。
    const LEADING_WHITESPACE = "  ";
    const FIRST_SENTENCE = "ボスの回答です。";
    const whole =
      `${LEADING_WHITESPACE}${FIRST_SENTENCE}<p class="x">甲</p><p>乙</p>と` +
      `<strong>丙</strong>、そして<br/>丁。`;
    const normalizedWhole = stripHtmlTags(whole);

    // 分割点はタグの外側（`>` の直後や `<` の直前）だけを選ぶ。
    const splitPoints = [
      1, // 先頭の空白の途中（まだ何にも一致していない）
      LEADING_WHITESPACE.length, // 先頭の空白の直後・本文の直前
      LEADING_WHITESPACE.length + Math.floor(FIRST_SENTENCE.length / 2), // 本文の途中
      whole.indexOf("<p"), // 最初のタグの直前
      whole.indexOf("甲</p>"),
      whole.indexOf("<p>乙"), // 連続する2つ目のブロックタグの直前
      whole.indexOf("乙</p>と"),
      whole.indexOf("<strong>"),
      whole.indexOf("</strong>、"),
      whole.indexOf("<br/>丁。"),
      whole.length,
    ];

    // 分割点はすべて相異なる位置であること（重複は検出力を失わせる）。
    expect(new Set(splitPoints).size).toBe(splitPoints.length);

    for (const splitPoint of splitPoints) {
      const prefix = whole.slice(0, splitPoint);
      const normalizedPrefix = stripHtmlTags(prefix);
      expect(
        normalizedWhole.startsWith(normalizedPrefix),
        `split at ${splitPoint}: "${normalizedPrefix}" should prefix "${normalizedWhole}"`,
      ).toBe(true);
    }
  });
});

describe("splitPendingTagTail", () => {
  it.each([
    { input: "", committed: "", pending: "" },
    { input: "ただの文章", committed: "ただの文章", pending: "" },
    // 閉じた `>` までは確定。以降の `<` から保留。
    { input: "甲<p>乙<b", committed: "甲<p>乙", pending: "<b" },
    { input: "<p>甲</p>", committed: "<p>甲</p>", pending: "" },
    // `>` が 1 つも無ければ最初の `<` 以降がすべて保留。
    { input: "x < 10", committed: "x ", pending: "< 10" },
    { input: "<br", committed: "", pending: "<br" },
    { input: '甲<div class="x"', committed: "甲", pending: '<div class="x"' },
  ])("splits $input into committed/pending", ({ input, committed, pending }) => {
    expect(splitPendingTagTail(input)).toEqual({ committed, pending });
    // 分割は情報を落とさない（連結すると入力に戻る）。
    expect(committed + pending).toBe(input);
  });

  // 「最後の `<`」で切ると壊れるケース。`"<a x "` を確定扱いにして送出すると、
  // 続く `">"` で全体が 1 個の `<a ...>` として一致し正規化結果が空になるため、
  // 送出済みの 5 文字を撤回できなくなる。最後の `>` より後の `<` は
  // **すべて** 保留しなければならない。
  it("holds back every '<' after the last '>', not just the last one", () => {
    expect(splitPendingTagTail("<a x <p")).toEqual({ committed: "", pending: "<a x <p" });
    expect(stripHtmlTags("<a x <p>")).toBe("");
  });

  // ストリーミングの不変条件そのもの: 任意の到着順で、確定部分を順に正規化して
  // 連結した結果が、常に全体の正規化結果の接頭辞になっている。
  it("keeps stripHtmlTags(committed) a prefix of stripHtmlTags(whole) at every arrival point", () => {
    const whole = '<p>甲</p>乙<strong>丙</strong>。x < 10 のとき<a href="u">丁</a><br';
    const normalizedWhole = stripHtmlTags(whole);

    for (let i = 0; i <= whole.length; i += 1) {
      const arrived = whole.slice(0, i);
      const normalizedCommitted = stripHtmlTags(splitPendingTagTail(arrived).committed);
      expect(
        normalizedWhole.startsWith(normalizedCommitted),
        `after ${i} chars: "${normalizedCommitted}" should prefix "${normalizedWhole}"`,
      ).toBe(true);
    }
  });
});
