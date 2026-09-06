import { useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import ChatView from "./ChatView";
import CheckinPanel from "./CheckinPanel";
import ConnectionStatus from "./ConnectionStatus";
import Dashboard from "./Dashboard";
import DailyReportView from "./DailyReportView";
import DecisionLog from "./DecisionLog";
import SettingsView from "./SettingsView";
import {
  SIDE_PANEL_MIN_WIDTH,
  SPLITTER_WIDTH,
  widthFromPointerX,
} from "./side-panel-width";
import TaskBoard from "./TaskBoard";
import TodaySummary from "./TodaySummary";
import { useChat } from "./use-chat";
import { useHealthCheck } from "./use-health-check";
import { useSidePanelWidth } from "./use-side-panel-width";
import { useTasks } from "./use-tasks";
import WorkLogView from "./WorkLogView";
import "./AppLayout.css";

// Keyboard step for the side panel splitter (Issue #362). Left/Right arrow
// keys move by this many px; not part of side-panel-width.ts's constant
// table because it's an event-wiring concern (this file), not a clamp rule.
const SPLITTER_KEYBOARD_STEP_PX = 16;

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
  // 右サイドパネルの幅（ドラッグ・キーボードで可変、localStorage に保存。Issue #362）。
  const sidePanelWidth = useSidePanelWidth();
  // ドラッグ中はテキスト選択を止める（.app-body--dragging で user-select:
  // none を当てる）。setPointerCapture だけではドラッグ起点のテキスト選択を
  // 抑止できないため（コードレビュー指摘）。
  const [isDraggingSplitter, setIsDraggingSplitter] = useState(false);

  function handleSplitterPointerDown(event: PointerEvent<HTMLDivElement>) {
    // Defensive: jsdom (and, in principle, a very old browser) doesn't
    // implement pointer capture. Fall back to no-op rather than throwing so
    // the drag-state toggle below still works for testing/degraded envs.
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setIsDraggingSplitter(true);
  }

  function handleSplitterPointerMove(event: PointerEvent<HTMLDivElement>) {
    // Gated on isDraggingSplitter (set by pointerdown/cleared by
    // pointerup/cancel) rather than event.currentTarget.hasPointerCapture:
    // the two should agree in a real browser, but hasPointerCapture doesn't
    // exist in jsdom, which would make this wiring untestable (code review
    // finding, Issue #362) — real drag-follow still isn't tested here, only
    // that a pointermove while dragging computes and applies a width.
    if (!isDraggingSplitter) {
      return;
    }
    sidePanelWidth.setWidth(
      widthFromPointerX(event.clientX, sidePanelWidth.windowWidth),
    );
  }

  function handleSplitterPointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (
      typeof event.currentTarget.hasPointerCapture === "function" &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsDraggingSplitter(false);
  }

  function handleSplitterKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        sidePanelWidth.setWidth(sidePanelWidth.width + SPLITTER_KEYBOARD_STEP_PX);
        break;
      case "ArrowRight":
        event.preventDefault();
        sidePanelWidth.setWidth(sidePanelWidth.width - SPLITTER_KEYBOARD_STEP_PX);
        break;
      case "Home":
        event.preventDefault();
        sidePanelWidth.setWidth(SIDE_PANEL_MIN_WIDTH);
        break;
      case "End":
        event.preventDefault();
        sidePanelWidth.setWidth(sidePanelWidth.effectiveMax);
        break;
      default:
        break;
    }
  }

  const appBodyStyle = {
    "--side-panel-width": `${sidePanelWidth.width}px`,
    "--splitter-width": `${SPLITTER_WIDTH}px`,
  } as CSSProperties;
  const appBodyClassName = isDraggingSplitter
    ? "app-body app-body--dragging"
    : "app-body";

  return (
    <div className="app-layout">
      <header className="app-header">
        <h1>ai-boss</h1>
        <ConnectionStatus status={healthStatus} />
      </header>
      <div className={appBodyClassName} style={appBodyStyle}>
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
        <div
          className="app-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="サイドパネルの幅"
          aria-controls="app-side-panel"
          aria-valuenow={sidePanelWidth.width}
          aria-valuemin={SIDE_PANEL_MIN_WIDTH}
          aria-valuemax={sidePanelWidth.effectiveMax}
          tabIndex={0}
          onPointerDown={handleSplitterPointerDown}
          onPointerMove={handleSplitterPointerMove}
          onPointerUp={handleSplitterPointerEnd}
          onPointerCancel={handleSplitterPointerEnd}
          onKeyDown={handleSplitterKeyDown}
        />
        <aside
          id="app-side-panel"
          className="app-side-panel"
          aria-label="サイドパネル"
        >
          <CheckinPanel tasksState={tasksState} />
          <TodaySummary tasks={tasksState.tasks} status={tasksState.status} />
        </aside>
      </div>
    </div>
  );
}

export default AppLayout;
