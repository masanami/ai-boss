// 「活動記録」（着手・休憩回数・休憩合計時間）の算出。DB・時刻・LLM に触れない
// 純粋関数として実装する（docs/features/daily-report.md「休憩イベントの対応付け
// 規則」「活動記録」）。呼び出し側（収集層）が対象範囲でフィルタ済みのイベント
// 配列を渡す。

/** 対応付けアルゴリズムが必要とする最小限のイベント形（activity_events の部分集合） */
export interface ActivityRecordEvent {
  id: number;
  created_at: string;
}

export interface ActivityRecordInput {
  /** 対象ローカル暦日の範囲でフィルタ済みの task_start イベント */
  taskStarts: ActivityRecordEvent[];
  /** 対象ローカル暦日の範囲でフィルタ済みの break_start イベント */
  breakStarts: ActivityRecordEvent[];
  /**
   * 対象ローカル暦日の範囲 ＋ 夕会セッションの ended_at まででフィルタ済みの
   * break_end イベント（日跨ぎ休憩を実測で対応付けるための拡張範囲）
   */
  breakEnds: ActivityRecordEvent[];
  /** 夕会セッションの ended_at（ISO文字列）。未対応の break_start の打ち切りに使う */
  sessionEndedAt: string;
}

export interface ActivityRecord {
  /** 当日最初の task_start の時刻（ISO文字列）。無ければ null */
  firstTaskStartAt: string | null;
  /** 当日の break_start の件数（未対応の break_end は数えない） */
  breakCount: number;
  /** 各休憩の対応付け結果の合計時間（分・切り捨て） */
  breakTotalMinutes: number;
}

function byCreatedAtThenId(a: ActivityRecordEvent, b: ActivityRecordEvent): number {
  const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  if (diff !== 0) return diff;
  return a.id - b.id;
}

interface BreakPair {
  start: ActivityRecordEvent;
  /** 対応する break_end。未対応（夕会 ended_at まで計上）の場合は null */
  end: ActivityRecordEvent | null;
}

/**
 * 休憩イベントの対応付け（FIFO）。走査順は created_at ASC, id ASC。
 * break_start はその後に現れる最初の未対応 break_end と対応付け、対応する
 * break_start の無い break_end（孤立）は無視する。対応が見つからない
 * break_start は end: null（呼び出し側が sessionEndedAt までを計上する）。
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

  const pendingStarts: ActivityRecordEvent[] = [];
  const pairs: BreakPair[] = [];

  for (const ev of events) {
    if (ev.kind === "start") {
      pendingStarts.push(ev);
      continue;
    }
    // ev.kind === "end"
    const matchedStart = pendingStarts.shift();
    if (matchedStart) {
      pairs.push({ start: matchedStart, end: ev });
    }
    // 対応する break_start が無い break_end（孤立）は無視する
  }

  // 夕会終了まで対応する break_end が見つからなかった break_start
  for (const start of pendingStarts) {
    pairs.push({ start, end: null });
  }

  return pairs;
}

export function computeActivityRecord(input: ActivityRecordInput): ActivityRecord {
  const sortedTaskStarts = [...input.taskStarts].sort(byCreatedAtThenId);
  const firstTaskStartAt = sortedTaskStarts.length > 0 ? sortedTaskStarts[0].created_at : null;

  const breakCount = input.breakStarts.length;

  const pairs = pairBreaks(input.breakStarts, input.breakEnds);
  const totalMs = pairs.reduce((sum, pair) => {
    const endIso = pair.end ? pair.end.created_at : input.sessionEndedAt;
    const durationMs = new Date(endIso).getTime() - new Date(pair.start.created_at).getTime();
    // 未対応（end: null）の場合、打ち切り時刻は夕会 sessionEndedAt。もし
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
