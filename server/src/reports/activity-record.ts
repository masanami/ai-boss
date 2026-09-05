// 「活動記録」（着手・休憩回数・休憩合計時間）の算出。DB・時刻・LLM に触れない
// 純粋関数として実装する（日報の「活動記録」を成立させる休憩イベントの
// 対応付け規則）。呼び出し側（収集層）が対象範囲でフィルタ済みのイベント
// 配列を渡す。

/** 対応付けアルゴリズムが必要とする最小限のイベント形（activity_events の部分集合） */
export interface ActivityRecordEvent {
  id: number;
  created_at: string;
}

export interface ActivityRecordInput {
  /** 対象ローカル暦日の範囲でフィルタ済みの task_start イベント */
  taskStarts: ActivityRecordEvent[];
  /**
   * `[対象ローカル暦日 00:00, max(翌ローカル暦日 00:00, 夕会 ended_at))` で
   * フィルタ済みの break_start イベント。**`breakEnds` と同じ窓**で取ること
   * （collect-daily-report-data.ts の `breakSearchEndIso`。Issue #237: 窓が
   * 非対称だと、翌暦日に始まった休憩の break_end が対象暦日の未終了 break_start
   * と誤って結ばれる）。
   *
   * 対象暦日の外（`nextDayStartIso` 以降）に始まる休憩は対応付けにだけ参加し、
   * `breakCount` / `breakTotalMinutes` には数えない（翌暦日の日報が生成されれば
   * そちらが計上する。同じ休憩を 2 日分の日報で二重計上しない）。
   */
  breakStarts: ActivityRecordEvent[];
  /**
   * `breakStarts` と同じ窓でフィルタ済みの break_end イベント。上限は**排他**
   * （ADR 0007 決定3 の半開区間）で、日跨ぎ夕会のときだけ翌暦日 00:00 より先へ
   * 伸びる——日跨ぎ休憩を実測で対応付けるための拡張範囲。
   *
   * 日跨ぎ夕会（`ended_at` > 翌暦日 00:00）の場合に限り、上限が `sessionEndedAt`
   * そのものになるため、`created_at` が `sessionEndedAt` と完全一致する break_end
   * は**この配列に含まれない**。その break_start は未対応として扱われ、下記
   * `sessionEndedAt` での打ち切りにより同じ時刻まで計上される——結果として
   * breakCount / breakTotalMinutes は「実測で対応付けた場合」と等価になる。
   * 同日内で終わる夕会ではそもそも上限が翌暦日 00:00 なので、`ended_at` ちょうどの
   * break_end は普通に含まれ、通常どおり対応付けられる。
   */
  breakEnds: ActivityRecordEvent[];
  /**
   * 翌ローカル暦日 00:00（ISO文字列・排他上限）。対象暦日に属する休憩
   * （`created_at` がこれより前の break_start）だけを回数・合計に数えるための
   * 境界。collect-daily-report-data.ts の `nextDayStartIso` と同じ値を渡す。
   */
  nextDayStartIso: string;
  /** 夕会セッションの ended_at（ISO文字列）。未対応の break_start の打ち切りに使う */
  sessionEndedAt: string;
}

export interface ActivityRecord {
  /** 当日最初の task_start の時刻（ISO文字列）。無ければ null */
  firstTaskStartAt: string | null;
  /** 対象暦日内に始まった break_start の件数（未対応の break_end は数えない） */
  breakCount: number;
  /** 対象暦日内に始まった各休憩の対応付け結果の合計時間（分・切り捨て） */
  breakTotalMinutes: number;
}

function byCreatedAtThenId(a: ActivityRecordEvent, b: ActivityRecordEvent): number {
  const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  if (diff !== 0) return diff;
  return a.id - b.id;
}

interface BreakPair {
  start: ActivityRecordEvent;
  /**
   * 休憩の終了時刻（ISO文字列）。対応する break_end の created_at、または
   * 後続の break_start による暗黙の閉じ。未対応（夕会 ended_at まで計上）の
   * 場合は null
   */
  endedAt: string | null;
}

/**
 * 休憩イベントの対応付け。走査順は created_at ASC, id ASC。
 *
 * 規則（Issue #237 で明示化。ADR 0007 帰結）: **休憩は同時に 1 つしか開かない**
 * （検知エンジンの detection/break-overrun.ts `getActiveBreak`・web の
 * deriveIsOnBreak と同じ単一状態）。API（POST /api/checkins）は `break_start` の
 * 連続を拒否せず、暦日をまたぐと GET /api/activity/today から前日の break_start
 * が消えて web が「休憩開始」ボタンを再表示するため、通常操作でも開いている
 * 休憩の上に break_start が来る（直接投入・後追い記録に限らない）。
 *
 * - break_start: 開いている休憩があれば、それを**この break_start の時刻で閉じ**、
 *   新しい休憩を開く（同じ人が同時に 2 つの休憩を取ることはできないため、
 *   重なりを二重計上しない）
 * - break_end: 開いている休憩を閉じる。開いている休憩が無い break_end（孤立）は
 *   無視する
 * - 走査後も開いている休憩は endedAt: null（呼び出し側が sessionEndedAt までを
 *   計上する）
 */
function pairBreaks(
  breakStarts: ActivityRecordEvent[],
  breakEnds: ActivityRecordEvent[],
): BreakPair[] {
  type Tagged = ActivityRecordEvent & { kind: "start" | "end" };
  const events: Tagged[] = [
    ...breakStarts.map((e): Tagged => ({ ...e, kind: "start" })),
    ...breakEnds.map((e): Tagged => ({ ...e, kind: "end" })),
  ].sort(byCreatedAtThenId);

  let openStart: ActivityRecordEvent | null = null;
  const pairs: BreakPair[] = [];

  for (const ev of events) {
    if (ev.kind === "start") {
      if (openStart) {
        pairs.push({ start: openStart, endedAt: ev.created_at });
      }
      openStart = ev;
      continue;
    }
    // ev.kind === "end"
    if (openStart) {
      pairs.push({ start: openStart, endedAt: ev.created_at });
      openStart = null;
    }
    // 開いている休憩が無い break_end（孤立）は無視する
  }

  // 夕会終了まで閉じられなかった休憩
  if (openStart) {
    pairs.push({ start: openStart, endedAt: null });
  }

  return pairs;
}

export function computeActivityRecord(input: ActivityRecordInput): ActivityRecord {
  const sortedTaskStarts = [...input.taskStarts].sort(byCreatedAtThenId);
  const firstTaskStartAt = sortedTaskStarts.length > 0 ? sortedTaskStarts[0].created_at : null;

  // 対応付けは窓全体（翌暦日に始まった休憩を含む）で行い、集計は対象暦日に
  // 始まった休憩だけに絞る（翌暦日の休憩は翌暦日の日報が計上する）。
  const nextDayStartMs = new Date(input.nextDayStartIso).getTime();
  const targetDayPairs = pairBreaks(input.breakStarts, input.breakEnds).filter(
    (pair) => new Date(pair.start.created_at).getTime() < nextDayStartMs,
  );

  const breakCount = targetDayPairs.length;

  const totalMs = targetDayPairs.reduce((sum, pair) => {
    const endIso = pair.endedAt ?? input.sessionEndedAt;
    const durationMs = new Date(endIso).getTime() - new Date(pair.start.created_at).getTime();
    // 未対応（endedAt: null）の場合、打ち切り時刻は夕会 sessionEndedAt。もし
    // break_start がそれより後（例: 夕会終了後の深夜に休憩を開始し、まだ
    // 戻っていない状態で日報を再生成した場合）だと durationMs が負になる。
    // 「打ち切り時刻までを計上する」という仕様の素直な帰結として、打ち切り
    // 時刻が開始より前なら休憩時間は 0 とみなす（負の休憩時間として合計に
    // 混入させない）。
    return sum + Math.max(0, durationMs);
  }, 0);
  const breakTotalMinutes = Math.floor(totalMs / (60 * 1000));

  return { firstTaskStartAt, breakCount, breakTotalMinutes };
}
