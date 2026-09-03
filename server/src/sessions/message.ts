export const MESSAGE_ROLES = ["user", "boss"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export interface Message {
  id: number;
  session_id: number;
  role: MessageRole;
  content: string;
  /**
   * `0` = 完結した応答 / `1` = 途中で終わった応答（#254）。
   *
   * 「**ユーザーが停止した**」ではなく「**この応答は途中で終わっており完結して
   * いない**」ことを表す。ユーザーが停止ボタン／ESC で打ち切った場合だけでなく、
   * LLM 呼び出しが失敗・タイムアウトして部分テキストだけが永続化される経路でも
   * `1` になる。画面に出したいのは「途中で終わっている」という事実であって
   * 原因ではないため。定義の正本は `db/migrate.ts` の version 5 のコメント。
   *
   * SQLite に真偽型が無いため `number`（既存慣習）。
   */
  interrupted: number;
  created_at: string;
}
