import type Database from "better-sqlite3";
import { resolveBossSettings } from "../boss/boss-settings.js";
import { buildPersonaPrompt } from "../boss/persona-prompt.js";
import { resolveLlmBackend, type LlmBackend } from "../config.js";
import { stripHtmlTags } from "../lib/strip-html-tags.js";
import {
  createClaudeClient,
  createBossMessage,
  type BossLlmMessage,
  type BossTextBlock,
} from "../llm/claude-client.js";
import { listTasks } from "../tasks/tasks-repository.js";
import type { Task } from "../tasks/task.js";
import { toDateKey } from "../detection/time-utils.js";
import { getCachedBossComment, setCachedBossComment } from "./boss-comment-cache.js";
import { computeTaskFingerprint } from "./task-fingerprint.js";

/**
 * ダッシュボードの「今日のひとこと」生成（Issue #58）。人格プロンプト生成器
 * （purpose: "notification"）＋ Claude クライアントで生成し、`boss-comment-cache.ts`
 * にキャッシュする。キャッシュキーはローカル日付**とタスク状態フィンガープリント
 * の両方**（Issue #121。`task-fingerprint.ts`）: 同日中でもタスクが作成・更新
 * されればフィンガープリントが変わり Claude を再度呼ぶ。日付・フィンガープリント
 * の両方が前回と一致するリクエストに限り Claude を呼ばずキャッシュを返す。
 *
 * `notification-body.ts` と同じ契約: API キー未設定・API エラー・空応答の
 * いずれでも例外を投げず、必ず `FALLBACK_COMMENT` を返す（呼び出し元＝
 * ダッシュボード API を 500 にしない、明示的な仮定）。フォールバックは
 * キャッシュしない（次回リクエストで再度生成を試みる）。
 *
 * FR-14（Issue #79）: `claude-code` バックエンドは `DASHBOARD_COMMENT_MAX_TOKENS`
 * に相当する応答長の直接制御手段を持たないため、プロンプトへ短文指示を追加し
 * （`CLAUDE_CODE_SHORT_TEXT_INSTRUCTION`）、生成後に全角 80 字相当を超えて
 * いないか検証する。超過時は「空応答」と同じ扱いでテンプレートフォールバック
 * する（`api` バックエンドの挙動は変えない — ロジック変更は最小限）。
 */

const DASHBOARD_COMMENT_MAX_TOKENS = 150;

const FALLBACK_COMMENT = "今日も決めたことを淡々とこなせ。";

const USER_INSTRUCTION =
  "ダッシュボードに表示する「今日のひとこと」を1つ生成せよ。現在のタスク状況を踏まえて、" +
  "今日一日のモチベーションになる短い一言にすること。出力は本文のみとし、前置き・説明・" +
  "カギ括弧などの装飾は付けないこと。1文の短い文章にすること。";

/** `claude-code` バックエンドのみに追加する短文指示（FR-14）。応答長の
 * リクエスト単位制御（`maxTokens` 相当）が無いための代替。テストが直接
 * 参照できるよう export する。 */
export const CLAUDE_CODE_SHORT_TEXT_INSTRUCTION =
  "出力は1文とし、全角80字以内（半角文字は0.5字として数える）に収めること。";

/** 全角 80 字相当の長さ検証用（FR-14）。半角相当の文字（U+0000–U+00FF）は
 * 0.5 字、それ以外は 1 字として数える単純な近似。 */
const DASHBOARD_COMMENT_MAX_ZENKAKU_LENGTH = 80;

function zenkakuEquivalentLength(text: string): number {
  let length = 0;
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    length += codePoint <= 0xff ? 0.5 : 1;
  }
  return length;
}

function buildUserInstruction(backend: LlmBackend): string {
  if (backend === "claude-code") {
    return `${USER_INSTRUCTION}\n${CLAUDE_CODE_SHORT_TEXT_INSTRUCTION}`;
  }
  return USER_INSTRUCTION;
}

function extractText(message: BossLlmMessage): string {
  return message.content
    .filter((block): block is BossTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

interface GenerationResult {
  text: string;
  /** false のとき `text` はフォールバック文言（キャッシュしない判断に使う）。 */
  succeeded: boolean;
}

async function generateBossComment(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  now: Date,
  tasks: Task[],
): Promise<GenerationResult> {
  try {
    const backend = resolveLlmBackend(env);
    const client = createClaudeClient(env, backend);
    const { model, persona } = resolveBossSettings(db);
    const system = buildPersonaPrompt(persona, {
      tasks,
      recentDecisions: [],
      now,
      purpose: "notification",
      // Issue #288: 出さない。このコメントは1日1回のキャッシュ（暦日＋タスク
      // fingerprint）で再利用されるため、分粒度の時刻を入れると朝生成した
      // 「もう10:05だ」が夕方まで表示される。時間帯ヒントは引き続き受け取る
      // ので時間帯粒度の文脈は保たれる。
      includeCurrentDateTime: false,
    });

    const message = await createBossMessage(client, {
      model,
      system,
      messages: [{ role: "user", content: buildUserInstruction(backend) }],
      maxTokens: DASHBOARD_COMMENT_MAX_TOKENS,
      // Issue #117: this route's `maxTokens` (150) is sized only for the
      // short comment itself. The facade already defaults `thinking` to
      // "disabled", but it's set explicitly here (rather than relying on
      // that default) because "no thinking" is part of *this route's own*
      // contract — a small max_tokens budget and any amount of thinking are
      // mutually exclusive here, so a test pins it directly instead of
      // depending on the facade's default staying what it is today.
      thinking: { type: "disabled" },
    });

    const text = extractText(message);
    if (text === "") {
      return { text: FALLBACK_COMMENT, succeeded: false };
    }
    // FR-14 の全角80字検証は**正規化前の生テキスト**に対して行う。タグ除去は
    // 文字を減らす方向にしか働かないため、生の長さで通れば正規化後も必ず通る
    // ＝表示値の上限として保守的に効く。この保守性は `stripHtmlTags` の置換先が
    // 1 文字以下（ブロック境界タグ→改行1個、インラインタグ→空文字）であることに
    // 依存している。置換先を 2 文字以上にする変更を入れるなら、この検証を
    // 正規化後の値に対して行うよう変えること（Issue #461 レビュー指摘）。
    if (backend === "claude-code" && zenkakuEquivalentLength(text) > DASHBOARD_COMMENT_MAX_ZENKAKU_LENGTH) {
      return { text: FALLBACK_COMMENT, succeeded: false };
    }
    // Issue #461（親 #446 S1）: 応答が許可リストのタグだけで構成される場合
    // （例: `<p></p>`）、上の `text === ""` ガードはすり抜けるが正規化後は
    // 空白・改行しか残らない。素通しすると空白だけのひとことがその暦日いっぱい
    // キャッシュされるため、**正規化後にも**空判定を行いフォールバックへ落とす
    // （上の空応答ガードと同じ意図を、正規化を挟んだ後でも保つ）。
    if (stripHtmlTags(text).trim() === "") {
      return { text: FALLBACK_COMMENT, succeeded: false };
    }
    // キャッシュへは**生の値**を渡す（正規化は下の getOrGenerateBossComment＝
    // 読み出し境界で行う）。機能仕様のクリティカル設計決定は「送出／読み出しの
    // 境界でのみ正規化する」であり、書き込み側で正規化すると**本変更より前に
    // 書かれたキャッシュ行**（`settings` テーブルに永続し、同一暦日＋同一タスク
    // fingerprint の間ヒットし続ける）が生のまま返って AC-18 を満たさない。
    return { text, succeeded: true };
  } catch (err) {
    // Claude API のエラーはリクエスト内部情報を含みうるため、クラス名のみ
    // ログに残す（chat-messages-route.ts / notification-body.ts と同じ規約）。
    console.error(
      "dashboard boss comment: generation failed, falling back to template:",
      err instanceof Error ? err.name : typeof err,
    );
    return { text: FALLBACK_COMMENT, succeeded: false };
  }
}

/**
 * 今日のひとことをキャッシュから取得する。キャッシュが無ければ Claude で
 * 生成し、成功した場合のみキャッシュへ保存する（フォールバック文言は
 * キャッシュしない）。
 *
 * Issue #461（親 #446 S1）: **この関数が正規化（`stripHtmlTags`）の適用点**
 * である。キャッシュヒット・ミスの両経路の合流点で掛けることで、キャッシュに
 * 何が入っていても——本変更より前に書かれた生の値であっても——返る値は
 * 正規化済みになる。正規化済みの文字列を再度通しても残存タグが無く恒等の
 * ため、二重適用は無害。
 *
 * キャッシュキーは日付に加えてタスク状態のフィンガープリント（Issue #121）
 * も使う。この関数の内部では `listTasks(db)` を一度だけ読み、その結果を
 * フィンガープリント算出と LLM への `buildPersonaPrompt` 入力の両方に
 * 使い回す（この関数内での読み取りの一貫性を保証し、この関数内での
 * 二重クエリを避ける — Issue #121 の要件どおり、この関数の公開シグネチャは
 * 変えていないため、呼び出し元 `dashboard-routes.ts` 側が別途行う
 * `listTasks(db)`（進捗計算用）とは別の読み取りになる）。
 */
export async function getOrGenerateBossComment(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<string> {
  const todayKey = toDateKey(now);
  const tasks = listTasks(db);
  const fingerprint = computeTaskFingerprint(tasks);

  const cached = getCachedBossComment(db, todayKey, fingerprint);
  if (cached !== undefined) {
    // Codex 指摘（PR #467）: 正規化後の空判定は生成側にもあるが、**旧版が
    // 書いたキャッシュ行**（`<p></p>` のようにタグだけを含む値。旧コードでは
    // valid だったので `settings` に残っている）はその判定を通っていない。
    // ここで同じ判定を掛けないと、日付かタスク fingerprint が変わるまで
    // ダッシュボードのひとことが空白のままになる。
    const normalizedCache = stripHtmlTags(cached);
    return normalizedCache.trim() === "" ? FALLBACK_COMMENT : normalizedCache;
  }

  const result = await generateBossComment(db, env, now, tasks);
  if (result.succeeded) {
    setCachedBossComment(db, todayKey, fingerprint, result.text);
  }
  return stripHtmlTags(result.text);
}
