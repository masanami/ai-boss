import { useState } from "react";
import ConnectionStatus from "./ConnectionStatus";
import TaskBoard from "./TaskBoard";
import { useHealthCheck } from "./use-health-check";
import "./AppLayout.css";

type AppView = "chat" | "tasks";

interface NavItem {
  label: string;
  view: AppView | null;
}

const NAV_ITEMS: NavItem[] = [
  { label: "チャット", view: "chat" },
  { label: "タスク", view: "tasks" },
  { label: "決定ログ", view: null },
  { label: "設定", view: null },
];

function AppLayout() {
  const healthStatus = useHealthCheck();
  const [activeView, setActiveView] = useState<AppView>("chat");

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
        {activeView === "chat" ? (
          <main className="app-main" aria-label="ボスとの対話">
            <p>ここにボスとの対話が表示されます（準備中）</p>
          </main>
        ) : (
          <main className="app-main" aria-label="タスクボード">
            <TaskBoard />
          </main>
        )}
        <aside className="app-side-panel" aria-label="サイドパネル">
          <section>
            <h2>今日のタスク</h2>
            <p>タスクはまだありません（準備中）</p>
          </section>
          <section>
            <h2>進捗</h2>
            <p>進捗はまだありません（準備中）</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

export default AppLayout;
