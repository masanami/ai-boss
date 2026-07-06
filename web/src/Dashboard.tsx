import BossAvatar from "./BossAvatar";
import { resolveBossExpression } from "./boss-expression";
import { toBossExpressionContext } from "./to-boss-expression-context";
import { resolveProgressLevel } from "./dashboard-progress-level";
import {
  resolveEveningEvaluationTone,
  type EveningEvaluationTone,
} from "./evening-evaluation";
import { useDashboard } from "./use-dashboard";
import "./Dashboard.css";

const EVENING_TONE_TITLE: Record<EveningEvaluationTone, string> = {
  praise: "よくやった",
  scold: "まだ足りない",
  neutral: "今日の夕会評価",
};

const EVENING_TONE_MESSAGE: Record<EveningEvaluationTone, string> = {
  praise: "今日のノルマをしっかり達成した。この調子を続けろ。",
  scold: "未達が多い。何が邪魔をしたのか、明日は改善しよう。",
  neutral: "半分程度は進んだ。明日はもう一段上を狙おう。",
};

function Dashboard() {
  const { dashboard, status } = useDashboard();

  if (status === "loading") {
    return <p className="dashboard-status">ダッシュボードを読み込み中…</p>;
  }
  if (status === "error" || dashboard === null) {
    return (
      <p className="dashboard-status" role="alert">
        ダッシュボードの取得に失敗しました
      </p>
    );
  }

  const { progress, bossComment, eveningSessionHeld } = dashboard;
  const percentage = Math.round(progress.ratio * 100);
  const progressLevel = resolveProgressLevel(progress.ratio);
  const expression = resolveBossExpression(toBossExpressionContext(dashboard));
  const eveningTone = resolveEveningEvaluationTone(progress.ratio);

  return (
    <div className="dashboard">
      <section className="dashboard-boss-row" aria-label="ボスから今日のひとこと">
        <BossAvatar expression={expression} />
        <div className="dashboard-boss-bubble">
          <p>{bossComment}</p>
        </div>
      </section>

      <section className="dashboard-progress" aria-label="進捗">
        <h2>今日のノルマ達成状況</h2>
        <div
          className="dashboard-progress-bar"
          role="progressbar"
          aria-label="今日の進捗"
          aria-valuenow={percentage}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`dashboard-progress-bar-fill dashboard-progress-bar-fill-${progressLevel}`}
            style={{ width: `${percentage}%` }}
          />
        </div>
        <p className="dashboard-progress-text">
          {progress.done} / {progress.total} 件完了（{percentage}%）
        </p>
      </section>

      {eveningSessionHeld && (
        <section
          className={`dashboard-evening-evaluation dashboard-evening-evaluation-${eveningTone}`}
          aria-label="夕会評価"
        >
          <h2>{EVENING_TONE_TITLE[eveningTone]}</h2>
          <p>{EVENING_TONE_MESSAGE[eveningTone]}</p>
        </section>
      )}
    </div>
  );
}

export default Dashboard;
