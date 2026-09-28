
import { RULE_TYPES } from "../notifications/notification-body.js";
import type { NudgeSchedulerPort, ScheduledNotificationRequest } from "./nudge-scheduler-port.js";

/**
 * `replan-nudges.test.ts` などが共通で使うテスト補助（`plan-test-fixtures.ts`
 * と同じ置き方）。
 */

/**
 * テストが開いた生の接続のうち、この補助が使う操作だけ。`.test.ts` でない
 * このファイルは better-sqlite3 を import しない
 * （`db/better-sqlite3-import-boundary.test.ts`）。
 */
interface RawConnection {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
  };
}

/** 8 ルール × 3 段階 × 3 通りの文面セット（C）の応答の JSON */
export function validMessageSetJson(template = "{task}を進めろ"): Record<string, Record<string, string[]>> {
  const result: Record<string, Record<string, string[]>> = {};
  for (const rule of RULE_TYPES) {
    result[rule] = {};
    for (const level of [1, 2, 3]) {
      result[rule][String(level)] = [0, 1, 2].map((v) => `${template} ${rule} L${level} v${v}`);
    }
  }
  return result;
}

/** 模擬の通知の予約ポート。OS に登録されている予約を `scheduled` に持つ */
export interface FakeSchedulerPort extends NudgeSchedulerPort {
  replacesSameId: boolean;
  scheduled: Map<number, ScheduledNotificationRequest>;
  calls: Array<{ op: "register" | "cancel"; id: number; body?: string }>;
  failRegister: (request: ScheduledNotificationRequest) => boolean;
  failCancel: (id: number) => boolean;
  /** register の前に待つ（計画し直しを途中で止めるため） */
  beforeRegister: (request: ScheduledNotificationRequest) => Promise<void>;
}

export function createFakeSchedulerPort(replacesSameId = true): FakeSchedulerPort {
  const port: FakeSchedulerPort = {
    replacesSameId,
    scheduled: new Map(),
    calls: [],
    failRegister: () => false,
    failCancel: () => false,
    beforeRegister: async () => undefined,
    async register(request) {
      await port.beforeRegister(request);
      port.calls.push({ op: "register", id: request.id, body: request.body });
      if (port.failRegister(request)) throw new Error("register failed");
      if (port.scheduled.has(request.id) && !port.replacesSameId) {
        throw new Error("duplicate id without replace support");
      }
      port.scheduled.set(request.id, request);
    },
    async cancel(id) {
      port.calls.push({ op: "cancel", id });
      if (port.failCancel(id)) throw new Error("cancel failed");
      port.scheduled.delete(id);
    },
  };
  return port;
}

export interface TaskRowInput {
  title?: string;
  description?: string | null;
  priority?: "high" | "medium" | "low" | null;
  status?: "todo" | "in_progress" | "paused" | "done" | "dropped";
  due_at?: string | null;
  evidence_required?: boolean;
  committed_start_at?: string | null;
  committed_at?: string | null;
  created_at: string;
}

export function insertTaskRow(raw: RawConnection, input: TaskRowInput): number {
  const result = raw
    .prepare(
      `INSERT INTO tasks (title, description, category, priority, due_at, status, created_at, updated_at,
         evidence_required, committed_start_at, committed_at)
       VALUES (?, ?, 'work', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.title ?? "資料作成",
      input.description ?? null,
      input.priority === undefined ? "high" : input.priority,
      input.due_at ?? null,
      input.status ?? "todo",
      input.created_at,
      input.created_at,
      input.evidence_required ? 1 : 0,
      input.committed_start_at ?? null,
      input.committed_at ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function insertSessionRow(raw: RawConnection, type: "morning" | "evening", startedAt: Date): void {
  raw.prepare("INSERT INTO sessions (type, started_at) VALUES (?, ?)").run(type, startedAt.toISOString());
}

export function insertActivityRow(raw: RawConnection, type: string, at: Date, taskId: number | null = null): void {
  raw
    .prepare("INSERT INTO activity_events (type, task_id, created_at) VALUES (?, ?, ?)")
    .run(type, taskId, at.toISOString());
}

export function putSettingRow(raw: RawConnection, key: string, value: string): void {
  raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

export interface ReservationRowView {
  id: number;
  reservation_key: string;
  kind: string;
  state: string;
  scheduled_at: string;
  rule_key: string | null;
  escalation_level: number | null;
  body: string;
  body_source: string;
  content_key: string | null;
}

export function reservationRows(raw: RawConnection): ReservationRowView[] {
  return raw
    .prepare("SELECT * FROM nudge_reservations ORDER BY scheduled_at ASC, id ASC")
    .all() as ReservationRowView[];
}


