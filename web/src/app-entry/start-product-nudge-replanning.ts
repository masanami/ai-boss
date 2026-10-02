import { createNudgeReplanner, type DbPort, type NudgeReplanner } from "../../../server/src/core-entry.js";
import { createProductNudgeSchedulerPort } from "./product-nudge-scheduler-port";

/**
 * 製品版のモバイル（iOS）の催促の予約の計画し直しの配線（#585 S3・機能仕様
 * docs/features/scheduled-nudges.md「製品版のエントリの配線」）。毎分の検知
 * （`start-product-scheduler.ts`）の代わりに、`boot-product-app.ts` が iOS の
 * ときだけ組む。macOS は毎分方式のまま（決定 5）。
 *
 * 計画し直しの契機（仮定 A27。`/api` の状態を変える要求の後の分は
 * `createProductCoreApp` の `onStateChangingRequest` が受け持つ）:
 * 1. 起動時に 1 回（DB の準備に成功した後。`boot-product-app.ts` が描画の後に呼ぶ）
 * 2. 前面への復帰（`visibilitychange` で `visible` になったとき）
 * 3. 前面にある間の定期（15 分ごと。仮定 A31）。iOS には毎分の刻み（`minute-tick`。
 *    macOS 専用の `desktop_shell.rs` が送る）が無いため WebView の中のタイマーで行う。
 *    `hidden` になったら止め、`visible` になったら始め直す（iOS は背面の WebView を
 *    止めるため、背面で動くことを前提にしない）。
 */

/** 前面にある間の定期の計画し直しの周期（仮定 A31。変えるときは受入基準も変える） */
export const NUDGE_REPLAN_INTERVAL_MS = 15 * 60 * 1000;

/** プラットフォームの判定（仮定 A26）: 製品版の web をビルドした Tauri の対象が iOS か */
export function isIosProductPlatform(platform: string | undefined): boolean {
  return platform === "ios";
}

/** `document` の前面・背面の状態と、その変化の購読（テストで差し替える） */
export interface VisibilitySource {
  isVisible: () => boolean;
  onChange: (handler: () => void) => void;
}

export interface IntervalTimers {
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface StartProductNudgeReplanningDeps {
  replanner: Pick<NudgeReplanner, "requestReplan">;
  visibility: VisibilitySource;
  timers: IntervalTimers;
}

export function startProductNudgeReplanning(deps: StartProductNudgeReplanningDeps): void {
  const { replanner, visibility, timers } = deps;
  let handle: unknown = null;

  // `requestReplan` は例外を投げない（失敗はログに出す）。同時に 1 本だけ
  // 走らせ、走っている間の要求は 1 回にまとめる。
  const replan = () => {
    void replanner.requestReplan();
  };

  const stopPeriodic = () => {
    if (handle !== null) {
      timers.clearInterval(handle);
      handle = null;
    }
  };
  const startPeriodic = () => {
    stopPeriodic();
    handle = timers.setInterval(replan, NUDGE_REPLAN_INTERVAL_MS);
  };

  visibility.onChange(() => {
    if (visibility.isVisible()) {
      replan();
      startPeriodic();
    } else {
      stopPeriodic();
    }
  });

  replan();
  if (visibility.isVisible()) startPeriodic();
}

export interface ProductNudgeReplanningDeps {
  /** `@tauri-apps/api/core` の `invoke`（製品版の通知の予約ポートが使う）。 */
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  visibility: VisibilitySource;
  timers: IntervalTimers;
  /** 現在時刻（テストで差し替える） */
  clock?: () => Date;
}

/** `boot-product-app.ts` の `nudgeReplanning` に渡す組み立て（iOS のときだけ使う） */
export interface ProductNudgeReplanning {
  /** DB の準備に成功した後、`/api` の振り向けより前に計画し直しを作る */
  createReplanner: (db: DbPort) => Pick<NudgeReplanner, "requestReplan">;
  /** 描画の後に、起動時の 1 回の計画し直しと前面・背面の購読を始める */
  start: (replanner: Pick<NudgeReplanner, "requestReplan">) => void;
}

export function createProductNudgeReplanning(deps: ProductNudgeReplanningDeps): ProductNudgeReplanning {
  const clock = deps.clock ?? (() => new Date());
  return {
    createReplanner: (db) =>
      createNudgeReplanner({
        db,
        env: {},
        port: createProductNudgeSchedulerPort({ invoke: deps.invoke, clock }),
        clock,
      }),
    start: (replanner) =>
      startProductNudgeReplanning({ replanner, visibility: deps.visibility, timers: deps.timers }),
  };
}

/**
 * 製品版のエントリ（`main.tsx`）が `bootProductApp` の `nudgeReplanning` に渡す
 * 値を選ぶ。iOS のときだけ組み、それ以外（macOS）は渡さない（毎分方式のまま）。
 */
export function selectProductNudgeReplanning(
  platform: string | undefined,
  deps: ProductNudgeReplanningDeps,
): ProductNudgeReplanning | undefined {
  return isIosProductPlatform(platform) ? createProductNudgeReplanning(deps) : undefined;
}
