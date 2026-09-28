import type { DbPort } from "../db/db-port.js";
import { resolveLlmBackend, type AppEnv } from "../config.js";
import { resolveBossSettingsFrom, type BossSettings } from "../boss/boss-settings.js";
import { readSettingsSnapshot } from "../settings/settings-repository.js";
import { resolveDetectionSettings } from "../scheduler/detection-settings.js";
import { listTodaysSessionTypes } from "../scheduler/todays-sessions.js";
import { toNotificationHistory } from "../scheduler/notification-history.js";
import { mapToNotificationRuleType, toEscalationLevel } from "../scheduler/rule-type-mapping.js";
import { listTasks } from "../tasks/tasks-repository.js";
import type { Task } from "../tasks/task.js";
import { listEventsSince } from "../activity/activity-events-repository.js";
import { listNotificationsSince } from "../notifications/notifications-repository.js";
import { findOverridesByDate } from "../meeting-schedule/meeting-schedule-repository.js";
import { resolveEffectiveMeetingTimes } from "../meeting-schedule/meeting-schedule.js";
import { parseDateKey, toLocalDateTimeKey } from "../detection/time-utils.js";
import {
  buildFallbackBody,
  buildNotificationLlmRequest,
  extractNotificationBody,
  extractText,
  DEFAULT_NOTIFICATION_TITLE,
  DEFAULT_TASK_TITLE,
  type NotificationBodyRequest,
} from "../notifications/notification-body.js";
import {
  createClaudeClient,
  streamBossMessage,
  type BossLlmClient,
  type ClaudeMessageRequest,
} from "../llm/claude-client.js";
import { compactPlanHistory } from "./compact-plan-history.js";
import {
  enumerateDateKeysInRange,
  planNudges,
  type DailyDetectionValues,
  type PlannedNudge,
} from "./plan-nudges.js";
import { reconcileReservations } from "./reconcile-reservations.js";
import type { NudgeSchedulerPort } from "./nudge-scheduler-port.js";
import {
  confirmAndRemoveReservations,
  deleteReservation,
  findReservationByKey,
  insertReservation,
  listReservations,
  setReservationState,
  updateReservationBody,
  type NewReservation,
  type NudgeReservationRow,
  type ReservationBodySource,
  type StoredReservation,
} from "./nudge-reservations-repository.js";
import {
  findIndividualBody,
  findMessageSet,
  pruneIndividualBodies,
  saveIndividualBody,
  saveMessageSet,
} from "./nudge-bodies-repository.js";
import {
  buildMessageSetLlmRequest,
  chooseVariantIndex,
  fillMessageTemplate,
  parseMessageSet,
  type MessageSet,
} from "./nudge-message-set.js";
import { tryReserveGenerationAttempt } from "./nudge-generation-limits.js";

/** 地平線（機能仕様 決定 1）: 計画した時刻から 24 時間 */
export const PLAN_HORIZON_MS = 24 * 60 * 60 * 1000;
/** OS の予約件数の上限（iOS。決定 3） */
export const OS_RESERVATION_LIMIT = 64;
/** 催促に使える件数（64 件のうち固定の通知の 1 件を常に確保する。決定 3） */
export const NUDGE_RESERVATION_LIMIT = OS_RESERVATION_LIMIT - 1;
/** B の生成の対象にする計画の先頭の件数（決定 4） */
export const INDIVIDUAL_GENERATION_TARGETS = 3;
/** B の生成の対象にする、予約時刻までの最短の余裕（決定 4） */
export const INDIVIDUAL_GENERATION_MIN_LEAD_MS = 60_000;
/** B へ差し替える、予約時刻までの最短の余裕（決定 4） */
export const INDIVIDUAL_SWAP_MIN_LEAD_MS = 30_000;
/** 固定の通知の文面（決定 3。人格設定によらない固定文・LLM で生成しない） */
export const REPORT_PROMPT_BODY = "しばらく報告が無い。アプリを開いて状況を報告しろ";
/** 約束の時刻が無いときの差し込み（C の `{time}`） */
const DEFAULT_COMMITMENT_TIME = "約束の時刻";

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

export interface NudgeReplannerDeps {
  db: DbPort;
  env: AppEnv;
  port: NudgeSchedulerPort;
  /** 現在時刻（テストで差し替える） */
  clock?: () => Date;
}

export interface NudgeReplanner {
  /**
   * 計画し直しの入口（機能仕様「S2 の設計」の契機がすべてここを呼ぶ）。
   * 走っている計画し直しがあれば 1 回にまとめ、それが終わった後にもう
   * 1 回走らせる。返す Promise は、この呼び出しを反映した計画し直し（突き
   * 合わせ・取り消し・計画・登録）が終わると解決する。文面の上乗せ（B・C
   * の生成）は待たない。例外を投げない（失敗はログに出す）。
   */
  requestReplan(): Promise<void>;
  /**
   * 計画し直しと、それが始めた文面の上乗せがすべて終わるまで待つ（器の終了
   * 処理〔S3〕とテストが、走っている生成との合流に使う）。
   */
  whenIdle(): Promise<void>;
}

/** 同じ予約を見分ける予約 ID（仮定 A9: rule_key・段階・予約時刻） */
export function nudgeReservationKey(nudge: { ruleKey: string; escalationLevel: number }, scheduledAt: Date): string {
  return `nudge|${nudge.ruleKey}|${nudge.escalationLevel}|${scheduledAt.toISOString()}`;
}

export function reportPromptReservationKey(scheduledAt: Date): string {
  return `report_prompt|${scheduledAt.toISOString()}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * B の使い回しのキー（決定 4）: LLM への入力全体（モデル名・システム
 * プロンプト・依頼文・最大トークン数）のハッシュ。
 */
export function individualContentKey(request: ClaudeMessageRequest): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      model: request.model,
      system: request.system,
      messages: request.messages,
      maxTokens: request.maxTokens,
    }),
  );
}

/** C の使い回しのキー: 人格設定（名前・口調・厳しさ・カスタム指示）のハッシュ（仮定 A15） */
export function messageSetPersonaKey(persona: BossSettings["persona"]): Promise<string> {
  return sha256Hex(
    JSON.stringify([persona.name, persona.tone, persona.strictness, persona.customInstructions]),
  );
}

/** 計画した催促 1 件と、その文面を決めるのに要る情報 */
interface PreparedNudge {
  nudge: PlannedNudge;
  reservationKey: string;
  task: Task | null;
  llmRequest: ClaudeMessageRequest;
  contentKey: string;
}

interface PlanSnapshot {
  plan: ReturnType<typeof planNudges>;
  tasks: Task[];
  bossSettings: BossSettings;
}

/**
 * 計画の入力を 1 つのトランザクションで読む（`scheduler-tick.ts` の
 * `buildTickInput` と同じ理由・#606: 別々に読むと、存在しなかった組み合わせを
 * 計画に渡しうる）。地平線に含まれる暦日ごとに、会の実効時刻（当日の上書きを
 * 合成）とその日のセッション種別を解決する（決定 1「暦日ごとの入力」）。
 */
async function readPlanSnapshot(db: DbPort, now: Date, maxCount: number): Promise<PlanSnapshot> {
  const horizonEnd = new Date(now.getTime() + PLAN_HORIZON_MS);
  return db.transaction(async (tx) => {
    const settingsSnapshot = await readSettingsSnapshot(tx);
    const {
      morningMeetingTime,
      eveningMeetingTime,
      ...settings
    } = resolveDetectionSettings(settingsSnapshot);
    const dailyValues = new Map<string, DailyDetectionValues>();
    for (const dateKey of enumerateDateKeysInRange(now, horizonEnd)) {
      const day = parseDateKey(dateKey);
      if (!day) throw new Error(`replan: unparseable date key ${dateKey}`);
      const effective = resolveEffectiveMeetingTimes(
        { morning: morningMeetingTime, evening: eveningMeetingTime },
        await findOverridesByDate(tx, dateKey),
      );
      dailyValues.set(dateKey, {
        morningMeetingTime: effective.morning,
        eveningMeetingTime: effective.evening,
        sessionTypes: await listTodaysSessionTypes(tx, day),
      });
    }

    const tasks = await listTasks(tx);
    const compacted = compactPlanHistory({
      now,
      tasks,
      activityEvents: await listEventsSince(tx, EPOCH_ISO),
      notifications: toNotificationHistory(await listNotificationsSince(tx, EPOCH_ISO)),
    });

    const plan = planNudges({
      now,
      horizonEnd,
      maxCount,
      tasks,
      activityEvents: compacted.activityEvents,
      notifications: compacted.notifications,
      settings,
      dailyValues,
    });
    return { plan, tasks, bossSettings: resolveBossSettingsFrom(settingsSnapshot) };
  });
}

function toBodyRequest(nudge: PlannedNudge, task: Task | null): NotificationBodyRequest {
  return {
    ruleType: mapToNotificationRuleType(nudge.ruleType),
    escalationLevel: toEscalationLevel(nudge.escalationLevel),
    task,
    // B は「現在日時」に予約時刻を渡す（決定 4）
    now: nudge.scheduledAt,
  };
}

/** 文面セット（C）から予約の文面を作る。差し込みはタスク名・約束の時刻 */
function bodyFromMessageSet(messageSet: MessageSet, prepared: PreparedNudge): string {
  const request = toBodyRequest(prepared.nudge, prepared.task);
  const variants = messageSet[request.ruleType][request.escalationLevel];
  const template = variants[chooseVariantIndex(prepared.reservationKey)] ?? variants[0];
  const commitment = prepared.task?.committed_start_at;
  return fillMessageTemplate(
    template,
    prepared.task?.title ?? DEFAULT_TASK_TITLE,
    commitment ? toLocalDateTimeKey(new Date(commitment)) : DEFAULT_COMMITMENT_TIME,
  );
}

/** 文面が決まる順序（決定 4）: B → C → 固定文 */
async function resolveBody(
  db: DbPort,
  prepared: PreparedNudge,
  messageSet: MessageSet | undefined,
): Promise<{ body: string; source: ReservationBodySource }> {
  const individual = await findIndividualBody(db, prepared.contentKey);
  if (individual !== undefined) return { body: individual, source: "individual" };
  if (messageSet) return { body: bodyFromMessageSet(messageSet, prepared), source: "message_set" };
  return { body: buildFallbackBody(toBodyRequest(prepared.nudge, prepared.task)), source: "fallback" };
}

function describeError(err: unknown): string {
  // LLM のエラーは要求の内部を message に含みうるため型名だけを出す
  // （notification-body.ts と同じ作法）。
  return err instanceof Error ? err.name : typeof err;
}

/** 非同期の処理を 1 本ずつ直列に流す単純な排他 */
function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * 催促の予約を計画し直す処理を作る（機能仕様 docs/features/scheduled-nudges.md
 * 決定 2〜4・「S2 の設計」）。OS の予約は {@link NudgeSchedulerPort} を通して
 * 扱う。S2 ではどこからも呼ばない（器・ポートの実装への接続は S3）。
 */
export function createNudgeReplanner(deps: NudgeReplannerDeps): NudgeReplanner {
  const { db, env, port } = deps;
  const clock = deps.clock ?? (() => new Date());
  const withLock = createMutex();
  const inFlightKeys = new Set<string>();
  const enrichments = new Set<Promise<void>>();

  let loop: Promise<void> | null = null;
  let rerunRequested = false;

  async function registerNew(reservation: NewReservation): Promise<void> {
    const id = await insertReservation(db, reservation);
    try {
      await port.register({
        id,
        at: new Date(reservation.scheduledAt),
        title: DEFAULT_NOTIFICATION_TITLE,
        body: reservation.body,
      });
    } catch (err) {
      // 登録に失敗した予約は控えに残さない（＝確定しない。決定 2）。
      await deleteReservation(db, id);
      console.error(
        `nudge replan: failed to register a reservation (key=${reservation.reservationKey}):`,
        describeError(err),
      );
    }
  }

  /** 取り消し待ちの行に同じ予約があれば有効に戻し、無ければ新しく登録する */
  async function placeReservation(
    reservation: NewReservation,
    pendingByKey: Map<string, NudgeReservationRow>,
  ): Promise<void> {
    const pending = pendingByKey.get(reservation.reservationKey);
    if (pending) {
      await setReservationState(db, pending.id, "active");
      pendingByKey.delete(reservation.reservationKey);
      return;
    }
    await registerNew(reservation);
  }

  async function cancelFuture(reservations: StoredReservation[]): Promise<void> {
    for (const { row } of reservations) {
      try {
        await port.cancel(row.id);
        await deleteReservation(db, row.id);
      } catch (err) {
        // 行を先に消すと、OS に残った古い催促を取り消す手がかりが無くなる（決定 2）
        await setReservationState(db, row.id, "pending_cancel");
        console.error(`nudge replan: failed to cancel a reservation (id=${row.id}):`, describeError(err));
      }
    }
  }

  async function replanOnce(): Promise<PreparedNudge[] | null> {
    const now = clock();

    // 1. 突き合わせ（決定 2）
    const reconciled = reconcileReservations(await listReservations(db), now);
    await confirmAndRemoveReservations(
      db,
      reconciled.confirmedReservations as StoredReservation[],
      reconciled.toDiscard as StoredReservation[],
    );

    // 2. 未来の予約の取り消し（失敗した行は取り消し待ちとして残る）
    await cancelFuture(reconciled.toCancel);
    const pendingRows = (await listReservations(db)).map(({ row }) => row);
    const pendingByKey = new Map(pendingRows.map((row) => [row.reservation_key, row]));

    // 3. 計画（取り消し待ちも OS の枠を使うため、その件数だけ上限を減らす）
    const maxCount = Math.max(0, NUDGE_RESERVATION_LIMIT - pendingRows.length);
    const { plan, tasks, bossSettings } = await readPlanSnapshot(db, now, maxCount);
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const messageSet = await findMessageSet(db, await messageSetPersonaKey(bossSettings.persona));
    await pruneIndividualBodies(db, now);

    // 4. 登録
    const prepared: PreparedNudge[] = [];
    for (const nudge of plan.nudges) {
      const task = nudge.taskId !== null ? (taskById.get(nudge.taskId) ?? null) : null;
      const llmRequest = buildNotificationLlmRequest(bossSettings, toBodyRequest(nudge, task));
      const item: PreparedNudge = {
        nudge,
        reservationKey: nudgeReservationKey(nudge, nudge.scheduledAt),
        task,
        llmRequest,
        contentKey: await individualContentKey(llmRequest),
      };
      prepared.push(item);
      const { body, source } = await resolveBody(db, item, messageSet);
      await placeReservation(
        {
          reservationKey: item.reservationKey,
          kind: "nudge",
          scheduledAt: nudge.scheduledAt.toISOString(),
          ruleType: nudge.ruleType,
          ruleKey: nudge.ruleKey,
          escalationLevel: nudge.escalationLevel,
          taskId: nudge.taskId,
          body,
          bodySource: source,
          contentKey: item.contentKey,
          registeredAt: now.toISOString(),
        },
        pendingByKey,
      );
    }

    // 固定の通知（決定 3）: 打ち切りの時刻、無ければ地平線の終わり。取り消し
    // 待ちだけで OS の枠（64 件）が埋まっているときは置けない（上限を守る側に
    // 倒す。取り消しが成功した次の計画し直しで置かれる）。
    if (pendingRows.length >= OS_RESERVATION_LIMIT) {
      console.error("nudge replan: pending cancellations fill the OS limit; the report prompt was not placed");
      startEnrichment(prepared.slice(0, INDIVIDUAL_GENERATION_TARGETS), bossSettings);
      return prepared;
    }
    const reportAt = plan.truncatedAt ?? new Date(now.getTime() + PLAN_HORIZON_MS);
    await placeReservation(
      {
        reservationKey: reportPromptReservationKey(reportAt),
        kind: "report_prompt",
        scheduledAt: reportAt.toISOString(),
        ruleType: null,
        ruleKey: null,
        escalationLevel: null,
        taskId: null,
        body: REPORT_PROMPT_BODY,
        bodySource: "report_prompt",
        contentKey: null,
        registeredAt: now.toISOString(),
      },
      pendingByKey,
    );

    startEnrichment(prepared.slice(0, INDIVIDUAL_GENERATION_TARGETS), bossSettings);
    return prepared;
  }

  /**
   * B の文面へ差し替える（決定 4）。生成の後に排他の中で、予約がまだ同じ
   * 使い回しのキーのまま有効に控えにあり、予約時刻まで 30 秒以上あるときだけ
   * 差し替える。差し替えの失敗で催促を失わない。
   */
  async function swapToIndividual(reservationKey: string, contentKey: string, body: string): Promise<void> {
    await withLock(async () => {
      const row = await findReservationByKey(db, reservationKey);
      if (!row || row.state !== "active" || row.content_key !== contentKey) return;
      if (new Date(row.scheduled_at).getTime() - clock().getTime() < INDIVIDUAL_SWAP_MIN_LEAD_MS) return;
      if (row.body === body) return;

      const request = (text: string) => ({
        id: row.id,
        at: new Date(row.scheduled_at),
        title: DEFAULT_NOTIFICATION_TITLE,
        body: text,
      });

      if (!port.replacesSameId) {
        try {
          await port.cancel(row.id);
        } catch (err) {
          // 取り消せなければ元の予約が残っているため、差し替えない
          console.error(`nudge swap: failed to cancel before swapping (id=${row.id}):`, describeError(err));
          return;
        }
      }
      try {
        await port.register(request(body));
        await updateReservationBody(db, row.id, body, "individual");
        return;
      } catch (err) {
        console.error(`nudge swap: failed to register the individual body (id=${row.id}):`, describeError(err));
      }
      try {
        await port.register(request(row.body));
      } catch (err) {
        console.error(`nudge swap: failed to restore the previous body (id=${row.id}):`, describeError(err));
        // 元の文面でも登録できなければ「登録に失敗した予約」（決定 2・4）:
        // 控えに残さず確定しない。次の計画し直しで登録し直される。置き換えの
        // 失敗では元の予約が OS に残りうる（控えを消すと取り消す手がかりを
        // 失う）ため、消す前に取り消しを 1 回試す（仮定 A16）。
        try {
          await port.cancel(row.id);
        } catch (cancelErr) {
          console.error(`nudge swap: failed to cancel before dropping (id=${row.id}):`, describeError(cancelErr));
        }
        await deleteReservation(db, row.id);
      }
    });
  }

  /**
   * LLM のクライアントを作る。作れない（バックエンドが未登録・API キーが無い
   * 等）なら null——試行の枠を使わずに生成をやめる。製品版の送信先の解決は
   * #582 S2 が呼び出し元ごとに置き換える（ここも対象）。
   */
  function tryCreateClient(): BossLlmClient | null {
    try {
      return createClaudeClient(env, resolveLlmBackend(env));
    } catch (err) {
      console.error("nudge generation: no LLM client is available:", describeError(err));
      return null;
    }
  }

  async function enrichIndividual(prepared: PreparedNudge): Promise<void> {
    if (prepared.nudge.scheduledAt.getTime() - clock().getTime() < INDIVIDUAL_GENERATION_MIN_LEAD_MS) return;
    const key = `individual:${prepared.contentKey}`;
    // 確かめてから確保するまでの間に await を挟まない（挟むと、並走する上乗せが
    // 両方とも未確保を観測し、同じ予約の生成と試行の枠を二重に使う）。
    if (inFlightKeys.has(key)) return;
    inFlightKeys.add(key);
    try {
      if ((await findIndividualBody(db, prepared.contentKey)) !== undefined) return;
      const client = tryCreateClient();
      if (!client) return;
      if (!(await tryReserveGenerationAttempt(db, "individual", clock()))) return;
      let body: string | null;
      try {
        body = extractNotificationBody(await streamBossMessage(client, prepared.llmRequest));
      } catch (err) {
        console.error("nudge individual body: generation failed:", describeError(err));
        return;
      }
      if (body === null) return;
      await saveIndividualBody(db, prepared.contentKey, body, prepared.nudge.scheduledAt, clock());
      await swapToIndividual(prepared.reservationKey, prepared.contentKey, body);
    } finally {
      inFlightKeys.delete(key);
    }
  }

  async function enrichMessageSet(bossSettings: BossSettings): Promise<void> {
    const personaKey = await messageSetPersonaKey(bossSettings.persona);
    const key = `message_set:${personaKey}`;
    // B と同じく、確かめてから確保するまでの間に await を挟まない
    if (inFlightKeys.has(key)) return;
    inFlightKeys.add(key);
    try {
      if ((await findMessageSet(db, personaKey)) !== undefined) return;
      const client = tryCreateClient();
      if (!client) return;
      if (!(await tryReserveGenerationAttempt(db, "message_set", clock()))) return;
      let text: string;
      try {
        text = extractText(
          await streamBossMessage(client, buildMessageSetLlmRequest(bossSettings.model, bossSettings.persona)),
        );
      } catch (err) {
        console.error("nudge message set: generation failed:", describeError(err));
        return;
      }
      const messageSet = parseMessageSet(text);
      if (!messageSet) {
        console.error("nudge message set: the response did not have the expected shape");
        return;
      }
      await saveMessageSet(db, personaKey, messageSet, clock());
    } finally {
      inFlightKeys.delete(key);
    }
  }

  function startEnrichment(targets: PreparedNudge[], bossSettings: BossSettings): void {
    const task = (async () => {
      for (const target of targets) {
        await enrichIndividual(target);
      }
      await enrichMessageSet(bossSettings);
    })().catch((err: unknown) => {
      console.error("nudge enrichment failed:", err instanceof Error ? (err.stack ?? err.message) : err);
    });
    enrichments.add(task);
    void task.finally(() => enrichments.delete(task));
  }

  async function runLoop(): Promise<void> {
    do {
      rerunRequested = false;
      try {
        await withLock(replanOnce);
      } catch (err) {
        console.error("nudge replan failed:", err instanceof Error ? (err.stack ?? err.message) : err);
      }
    } while (rerunRequested);
    // 再実行の要否の判定と同じ同期の区間で解除する（`.finally` で後から
    // 解除すると、その間に来た要求が終わりかけの loop に吸われて失われる）。
    loop = null;
  }

  return {
    requestReplan(): Promise<void> {
      if (loop) {
        rerunRequested = true;
        return loop;
      }
      const started = runLoop();
      // runLoop が同期的に終わることは無い（最初の await で戻る）ため、
      // 解除（runLoop の末尾）より先にここで代入される。
      loop = started;
      return started;
    },
    async whenIdle(): Promise<void> {
      while (loop || enrichments.size > 0) {
        await Promise.all([loop, ...enrichments]);
      }
    },
  };
}
