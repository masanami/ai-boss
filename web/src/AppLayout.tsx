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
import WorkLogView from "./WorkLogView";
import { useChat } from "./use-chat";
import { useHealthCheck } from "./use-health-check";
import { useTasks } from "./use-tasks";
import "./AppLayout.css";

type AppView =
  | "dashboard"
  | "chat"
  | "tasks"
  | "decisions"
  | "reports"
  | "work-logs"
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
  { label: "作業ログ", view: "work-logs" },
  { label: "設定", view: "settings" },
];

function AppLayout() {
  const healthStatus = useHealthCheck();
  // tasks はタスクボード・チェックイン・サイドパネルで共有するため、
  // 共通の親であるここに1回だけ持つ（リフトアップ、Issue #70）。
  const tasksState = useTasks();
  // chat も同じ理由でここに1回だけ持つ（リフトアップ、Issue #93）。
  // ビュー切替は条件レンダリングのため ChatView 内に置くと会話状態がタブ遷移の
  // たびにアンマウントで失われる。tasksState と同じパターンに揃えることで、
  // タブを離れても朝会・夕会の会話が継続する。トレードオフとして、チャット
  // タブを開かなくてもアプリ起動時に useChat の初期フェッチが走るが、
  // useTasks も同じ挙動であり許容する。
  const chatState = useChat();
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
            <ChatView chatState={chatState} />
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
        {activeView === "work-logs" && (
          <main className="app-main" aria-label="作業ログ">
            <WorkLogView />
          </main>
        )}
        {activeView === "settings" && (
          <main className="app-main" aria-label="設定">
            <SettingsView />
          </main>
        )}
        <aside className="app-side-panel" aria-label="サイドパネル">
          <CheckinPanel tasksState={tasksState} />
          <TodaySummary tasks={tasksState.tasks} status={tasksState.status} />
        </aside>
      </div>
    </div>
  );
}

export default AppLayout;
