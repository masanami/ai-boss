import { useState } from "react";
import ChatView from "./ChatView";
import CheckinPanel from "./CheckinPanel";
import ConnectionStatus from "./ConnectionStatus";
import Dashboard from "./Dashboard";
import DailyReportView from "./DailyReportView";
import DecisionLog from "./DecisionLog";
import SettingsView from "./SettingsView";
import TaskBoard from "./TaskBoard";
import TodaySummary from "./TodaySummary";
import { useHealthCheck } from "./use-health-check";
import { useTasks } from "./use-tasks";
import "./AppLayout.css";

type AppView =
  | "dashboard"
  | "chat"
  | "tasks"
  | "decisions"
  | "reports"
  | "settings";

interface NavItem {
  label: string;
  view: AppView | null;
}

const NAV_ITEMS: NavItem[] = [
  { label: "ダッシュボード", view: "dashboard" },
  { label: "チャット", view: "chat" },
  { label: "タスク", view: "tasks" },
  { label: "決定ログ", view: "decisions" },
  { label: "日報", view: "reports" },
  { label: "設定", view: "settings" },
];

function AppLayout() {
  const healthStatus = useHealthCheck();
  // tasks はタスクボード・チェックイン・サイドパネルで共有するため、
  // 共通の親であるここに1回だけ持つ（リフトアップ、Issue #70）。
  const tasksState = useTasks();
  // ダッシュボードを既定ビューにする（Issue #60 の明示的な仮定: ダッシュボード
  // はアプリの顔。チャット中心の仕様とはナビ1クリックで両立させる）。
  const [activeView, setActiveView] = useState<AppView>("dashboard");

  return (
    <div className="app-layout">
      <header className="app-header">
        <h1>ai-boss</h1>
        <ConnectionStatus status={healthStatus} />
      </header>
      <div className="app-body">
        <nav className="app-nav" aria-label="メインナビゲーション">
          <ul>
            {NAV_ITEMS.map((item) => (
              <li key={item.label}>
                <button
                  type="button"
                  disabled={item.view === null}
                  onClick={
                    item.view === null
                      ? undefined
                      : () => setActiveView(item.view as AppView)
                  }
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {activeView === "dashboard" && (
          <main className="app-main" aria-label="ダッシュボード">
            <Dashboard />
          </main>
        )}
        {activeView === "chat" && (
          <main className="app-main" aria-label="ボスとの対話">
            <ChatView />
          </main>
        )}
        {activeView === "tasks" && (
          <main className="app-main" aria-label="タスクボード">
            <TaskBoard tasksState={tasksState} />
          </main>
        )}
        {activeView === "decisions" && (
          <main className="app-main" aria-label="決定ログ">
            <DecisionLog />
          </main>
        )}
        {activeView === "reports" && (
          <main className="app-main" aria-label="日報">
            <DailyReportView />
          </main>
        )}
        {activeView === "settings" && (
          <main className="app-main" aria-label="設定">
            <SettingsView />
          </main>
        )}
        <aside className="app-side-panel" aria-label="サイドパネル">
          <CheckinPanel tasks={tasksState.tasks} />
          <TodaySummary tasks={tasksState.tasks} status={tasksState.status} />
        </aside>
      </div>
    </div>
  );
}

export default AppLayout;
