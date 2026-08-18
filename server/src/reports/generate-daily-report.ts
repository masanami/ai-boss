// 日報生成サービス（依存チケット #106/#107 の成果物を結線する「生成サービス」
// 本体）。docs/features/daily-report.md「機能全体の設計」の4段:
//   1. 収集: collectDailyReportData（#106）
//   2. 値の抽出: extractEveningSummary（本チケット）
//   3. レンダリング: renderDailyReport（#106、通常/フォールバック経路で共用）
//   4. 保存: upsertDailyReport（#106）
// を1関数に結線する。自動生成（夕会終了フック、#109）と手動再生成（#109/#110
// のルート）は、この単一の関数を共通して呼ぶ。
import type Database from "better-sqlite3";
import { toDateKey } from "../detection/time-utils.js";
import { findSessionById, listSessions } from "../sessions/sessions-repository.js";
import { listMessagesBySessionId } from "../sessions/messages-repository.js";
import type { Session } from "../sessions/session.js";
import { collectDailyReportData } from "./collect-daily-report-data.js";
import { extractEveningSummary } from "./extract-evening-summary.js";
import { renderDailyReport } from "./render-daily-report.js";
import { upsertDailyReport } from "./daily-reports-repository.js";
import type { DailyReport } from "./daily-report.js";

export type GenerateDailyReportResult =
  | { ok: true; report: DailyReport }
  | { ok: false; code: "evening_session_required" };

export interface GenerateDailyReportOptions {
  /**
   * LLM による4値抽出ステップに渡す任意の上限時間（ms）。指定時は超過時点で
   * 4値なしと見なしフォールバックへ進む。未指定時はタイムアウトを設けない
   * （LLM クライアント既定のタイムアウト方針に委ねる）。既定20秒を渡すのは
   * 夕会終了フック側（依存チケット #109）の責務であり、本サービスは受け口
   * だけを用意する。
   */
  timeoutMs?: number;
  /**
   * 対象夕会セッションを id で直接指定する。指定時はこのセッションの
   * `started_at` のローカル日付が対象暦日になり、`now` には依存しない
   * （日付をまたぐ夕会でも `now`（呼び出し時の実時刻）に左右されず開始日を
   * 正しく解決できる — 親要件チケット #100 のクリティカル設計決定
   * 「日付基準の統一」）。夕会終了フック（#109）はこの経路で「今まさに
   * 終了させたセッション」を直接渡すことを想定する。
   *
   * 未指定時は従来どおり `toDateKey(now)` に一致する `started_at` を持つ
   * 夕会（`type = evening`）を検索する（手動再生成 `POST
   * /api/reports/generate` の経路 — 「今日」の夕会を探す）。
   *
   * 指定した id が存在しない、または `type` が `evening` でない場合は
   * 「有効な対象夕会が無い」として扱い、`{ ok: false, code:
   * "evening_session_required" }` を返す（前提条件チェックと同じ失敗値。
   * 新しい discriminant は増やさない）。
   */
  eveningSessionId?: number;
}

/**
 * `now` のローカル日付に属する夕会セッション（`type = evening` かつ
 * `started_at` のローカル日付が一致するもの）を探す。`listSessions` は
 * `started_at DESC, id DESC` で返すため、複数あればその順で先頭（最新）が
 * 選ばれる（docs/features/daily-report.md「対象夕会の特定」）。
 */
function findTodaysEveningSession(
  db: Database.Database,
  now: Date,
): Session | undefined {
  const todayKey = toDateKey(now);
  return listSessions(db, { type: "evening" }).find(
    (session) => toDateKey(new Date(session.started_at)) === todayKey,
  );
}

/**
 * 対象夕会セッションを解決する。`eveningSessionId` が指定されていれば
 * それを直接引く（`type !== "evening"` なら「対象夕会なし」扱いで
 * `undefined`）。未指定なら `now` ベースの検索（{@link
 * findTodaysEveningSession}）にフォールバックする。
 */
function resolveTargetEveningSession(
  db: Database.Database,
  now: Date,
  eveningSessionId: number | undefined,
): Session | undefined {
  if (eveningSessionId !== undefined) {
    const session = findSessionById(db, eveningSessionId);
    if (!session || session.type !== "evening") {
      return undefined;
    }
    return session;
  }
  return findTodaysEveningSession(db, now);
}

/**
 * 前提条件（壁打ち強制）: 対象夕会が存在し、終了済み（`ended_at` が非
 * NULL）で、かつ `role = user` のメッセージが1件以上あるときのみ生成できる
 * （docs/features/daily-report.md）。満たさない場合は例外を投げず、判別
 * 可能な失敗値 `{ ok: false, code: "evening_session_required" }` を返す。
 * フォールバック経路（LLM 抽出失敗）でもこの前提条件チェックは維持される
 * — 呼び出し元がこのチェックを一度だけ通れば、以降 LLM が失敗しても
 * フォールバック日報を保存できる設計になっている。
 */
function checkPrerequisite(
  db: Database.Database,
  now: Date,
  eveningSessionId: number | undefined,
): { ok: true; session: Session } | { ok: false; code: "evening_session_required" } {
  const session = resolveTargetEveningSession(db, now, eveningSessionId);
  if (!session || session.ended_at === null) {
    return { ok: false, code: "evening_session_required" };
  }

  const userMessageCount = listMessagesBySessionId(db, session.id).filter(
    (message) => message.role === "user",
  ).length;
  if (userMessageCount === 0) {
    return { ok: false, code: "evening_session_required" };
  }

  return { ok: true, session };
}

/**
 * 当日の日報を生成し保存する。自動生成（夕会終了フック）と手動再生成の
 * 両経路が共通で使う単一の入口（docs/features/daily-report.md「機能全体の
 * 設計」）。
 *
 * - 対象夕会は `options.eveningSessionId` を指定すればそのセッションに
 *   固定され（`now` に依存しない — 日付をまたぐ夕会の対応、下記参照）、
 *   未指定なら `now` のローカル日付から検索する（{@link
 *   resolveTargetEveningSession}）。前提条件チェックはどちらの経路でも
 *   共通に効く
 * - 前提条件を満たさない場合は日報を保存せず `{ ok: false, code:
 *   "evening_session_required" }` を返す
 * - 4値抽出（`extractEveningSummary`）が失敗・タイムアウト・形式不正の場合
 *   でも例外を投げず、同じレンダラーへ4値なしで渡したフォールバック日報を
 *   保存して返す（4値が無いことは生成失敗ではない）
 * - 対象ローカル暦日・`daily_reports.date`・表題は対象夕会の `started_at`
 *   のローカル日付（`toDateKey`）に従う（`now` の日付ではない）
 * - 同日に複数回呼んでも `daily_reports` の同日行が UPSERT される（行数は
 *   増えない）
 */
export async function generateDailyReport(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  now: Date,
  options: GenerateDailyReportOptions = {},
): Promise<GenerateDailyReportResult> {
  const prerequisite = checkPrerequisite(db, now, options.eveningSessionId);
  if (!prerequisite.ok) {
    return prerequisite;
  }
  const { session } = prerequisite;

  const collected = collectDailyReportData(db, session);
  const eveningMessages = listMessagesBySessionId(db, session.id);

  // 収集した当日の active 決定一覧は、日報の「決定事項」セクション（Issue
  // #144 で廃止）へは渡さず、抽出ステップのコンテキストへ渡す（「決定の
  // 要点」の抽出材料。docs/features/work-log.md「日報側の変更」）。
  const eveningSummary = await extractEveningSummary(
    db,
    env,
    eveningMessages,
    collected.decisions,
    now,
    { timeoutMs: options.timeoutMs },
  );

  const content = renderDailyReport({
    date: collected.targetDate,
    completedTasks: collected.completedTasks,
    inProgressTasks: collected.inProgressTasks,
    firstTaskStartAt: collected.firstTaskStartAt,
    breakCount: collected.breakCount,
    breakTotalMinutes: collected.breakTotalMinutes,
    eveningSummary,
  });

  const report = upsertDailyReport(db, {
    date: toDateKey(collected.targetDate),
    content,
    evening_session_id: session.id,
  });

  return { ok: true, report };
}
