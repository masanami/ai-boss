import ConnectionStatus from "./ConnectionStatus";
import { useHealthCheck } from "./use-health-check";
import "./AppLayout.css";

const NAV_ITEMS = ["チャット", "タスク", "決定ログ", "設定"];

function AppLayout() {
  const healthStatus = useHealthCheck();

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
              <li key={item}>
                <button type="button">{item}</button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="app-main" aria-label="ボスとの対話">
          <p>ここにボスとの対話が表示されます（準備中）</p>
        </main>
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
