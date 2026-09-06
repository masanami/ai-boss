import { useCallback, useEffect, useRef, useState } from "react";
import {
  addFileEvidence,
  addLinkEvidence,
  deleteTaskEvidence,
  describeTasksApiError,
  evidenceContentUrl,
  fetchTaskEvidences,
} from "./tasks-api";
import type { TaskEvidence } from "./task-evidence";

export type EvidenceListStatus = "idle" | "loading" | "ready" | "error";

export interface UseTaskEvidencesResult {
  evidences: TaskEvidence[];
  status: EvidenceListStatus;
  /** 追加・削除の失敗理由（UI 所有の日本語文言）。成功・未操作なら null。 */
  actionError: string | null;
  /** 追加・削除が飛んでいる間 true。連打防止のため UI を disabled にする。 */
  isMutating: boolean;
  /**
   * いずれも成功したら true を返す（`TaskCard` の `onEdit` と同じ規約）。
   * 呼び出し元は失敗時に入力欄を消さない等の判断にこれを使う。連打ガードで
   * 弾かれた呼び出しも false を返す。
   */
  addFile: (file: File) => Promise<boolean>;
  addLink: (url: string) => Promise<boolean>;
  remove: (evidenceId: number) => Promise<boolean>;
  /**
   * ファイル型エビデンスの本体を開く URL（`<a href>` 用）。閲覧は遷移で行い
   * 独自ビューアは作らない（明示的な仮定 9）ため、fetch はしない。
   */
  contentUrl: (evidenceId: number) => string;
}

/**
 * 1 タスクのエビデンス（一覧・追加・削除）の IO を所有するフック。
 *
 * この web/ は「コンポーネントは表示に徹し、IO は `use-*` フックが所有する」
 * 構造（`use-tasks` / `use-settings` / `use-checkin-panel` 等）なので、
 * エビデンスもその規約に合わせて `TaskCard` から切り出している。
 *
 * `enabled` が false の間は何も取得しない（タスク一覧の各カードが常時取得すると
 * N+1 になるため、編集モードに入っている間だけ取得する）。
 */
export function useTaskEvidences(
  taskId: number,
  enabled: boolean,
): UseTaskEvidencesResult {
  const [evidences, setEvidences] = useState<TaskEvidence[]>([]);
  const [status, setStatus] = useState<EvidenceListStatus>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [isMutating, setIsMutating] = useState(false);

  // 一覧取得の世代番号。**追加・削除が成功するたびにも進める**ことで、
  // 「取得の応答が届く前に追加が成功した」競合で、先行する取得の古い一覧が
  // 追加分を上書きして消すのを防ぐ（`use-tasks` の refresh と同じ考え方）。
  const generationRef = useRef(0);
  // 連打による重複 POST / DELETE を防ぐ（`use-checkin-panel` の submittingRef と
  // 同じ規律）。state ではなく ref で見るのは、同一ターン内の 2 回目の呼び出しが
  // 再レンダリング前でも弾かれるようにするため。
  const mutatingRef = useRef(false);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setStatus("loading");
    // 取得をやり直す＝直前の操作の結果は画面に反映済みなので、古い失敗理由は消す
    // （編集モードに入り直したときに前回のエラーが残らない）。
    setActionError(null);
    try {
      const list = await fetchTaskEvidences(taskId);
      if (generation !== generationRef.current) {
        return;
      }
      setEvidences(list);
      setStatus("ready");
    } catch {
      if (generation !== generationRef.current) {
        return;
      }
      setStatus("error");
    }
  }, [taskId]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void load();
  }, [enabled, load]);

  /**
   * 追加・削除の共通処理。成功したら次の 3 つを順に行う（それぞれ別の失敗経路を
   * 塞いでおり、独立している）:
   *
   * 1. `applyLocally` で手元の一覧を更新し、すぐ画面に反映する
   * 2. **世代番号を進めて、飛んでいる古い取得の結果を無効化する**。これが無いと
   *    「取得の応答が届く前に追加が成功した」場合に、あとから届いた古い一覧が
   *    1 の結果を上書きして追加分が消える
   * 3. **一覧を取り直す**。これが無いと、初回取得が失敗して status が "error" の
   *    ままのとき、追加が成功しても一覧が描画されず（1 の更新は不可視の state に
   *    入るだけ）ユーザーには失敗したように見える
   */
  const runMutation = useCallback(
    async <T,>(
      operation: () => Promise<T>,
      applyLocally: (result: T) => void,
      fallbackMessage: string,
    ): Promise<boolean> => {
      if (mutatingRef.current) {
        return false;
      }
      mutatingRef.current = true;
      setIsMutating(true);
      setActionError(null);
      try {
        const result = await operation();
        applyLocally(result);
        generationRef.current += 1;
        await load();
        return true;
      } catch (error: unknown) {
        setActionError(describeTasksApiError(error, fallbackMessage));
        return false;
      } finally {
        mutatingRef.current = false;
        setIsMutating(false);
      }
    },
    [load],
  );

  const appendEvidence = useCallback((created: TaskEvidence) => {
    setEvidences((prev) => [...prev, created]);
  }, []);

  const addFile = useCallback(
    (file: File) =>
      runMutation(
        () => addFileEvidence(taskId, file),
        appendEvidence,
        "エビデンスの追加に失敗しました",
      ),
    [appendEvidence, runMutation, taskId],
  );

  const addLink = useCallback(
    (url: string) =>
      runMutation(
        () => addLinkEvidence(taskId, url),
        appendEvidence,
        "エビデンスの追加に失敗しました",
      ),
    [appendEvidence, runMutation, taskId],
  );

  const remove = useCallback(
    (evidenceId: number) =>
      runMutation(
        () => deleteTaskEvidence(taskId, evidenceId),
        () => {
          setEvidences((prev) =>
            prev.filter((item) => item.id !== evidenceId),
          );
        },
        "エビデンスの削除に失敗しました",
      ),
    [runMutation, taskId],
  );

  const contentUrl = useCallback(
    (evidenceId: number) => evidenceContentUrl(taskId, evidenceId),
    [taskId],
  );

  return {
    evidences,
    status,
    actionError,
    isMutating,
    addFile,
    addLink,
    remove,
    contentUrl,
  };
}
