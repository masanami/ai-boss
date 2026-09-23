import { useEffect, useState } from "react";
import type { DashboardResponse } from "./dashboard-response";

// スパイク: 元の useDashboard（GET /api/dashboard）をダミーデータの巡回に差し替える。
// 表情（normal → encouraging → satisfied → displeased）と進捗ゲージの遷移を 2.5 秒ごとに起こす。
export const DUMMY_SCENARIOS: DashboardResponse[] = [
  { progress: { done: 2, total: 5, ratio: 0.4 }, morningSessionHeld: false, eveningSessionHeld: false, todayMaxEscalationLevel: 0, bossComment: "今日は資料作成を最優先にしろ。", date: "2026-09-23" },
  { progress: { done: 1, total: 5, ratio: 0.2 }, morningSessionHeld: true, eveningSessionHeld: false, todayMaxEscalationLevel: 0, bossComment: "まだ 1 件か。次の 30 分で 1 つ片付けろ。", date: "2026-09-23" },
  { progress: { done: 4, total: 5, ratio: 0.8 }, morningSessionHeld: true, eveningSessionHeld: true, todayMaxEscalationLevel: 0, bossComment: "よくやった。明日もこの調子だ。", date: "2026-09-23" },
  { progress: { done: 1, total: 5, ratio: 0.2 }, morningSessionHeld: true, eveningSessionHeld: true, todayMaxEscalationLevel: 2, bossComment: "催促を 2 回無視したな。理由を報告しろ。", date: "2026-09-23" },
];

export type DashboardLoadStatus = "loading" | "ready" | "error";

export function useDashboard(intervalMs = 2500) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % DUMMY_SCENARIOS.length), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return { dashboard: DUMMY_SCENARIOS[index], status: "ready" as DashboardLoadStatus };
}
