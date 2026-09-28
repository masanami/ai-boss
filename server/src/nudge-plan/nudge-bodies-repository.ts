import type { Db } from "../db/db-port.js";
import type { MessageSet } from "./nudge-message-set.js";

/** 保存した B の文面のうち、予約時刻からこれより古いものは使われないため消す */
const INDIVIDUAL_BODY_RETENTION_MS = 24 * 60 * 60 * 1000;

export async function findIndividualBody(db: Db, contentKey: string): Promise<string | undefined> {
  const row = await db.get<{ body: string }>(
    "SELECT body FROM nudge_individual_bodies WHERE content_key = ?",
    [contentKey],
  );
  return row?.body;
}

export async function saveIndividualBody(
  db: Db,
  contentKey: string,
  body: string,
  scheduledAt: Date,
  now: Date,
): Promise<void> {
  await db.run(
    `INSERT INTO nudge_individual_bodies (content_key, body, scheduled_at, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (content_key) DO UPDATE SET body = excluded.body`,
    [contentKey, body, scheduledAt.toISOString(), now.toISOString()],
  );
}

export async function pruneIndividualBodies(db: Db, now: Date): Promise<void> {
  await db.run("DELETE FROM nudge_individual_bodies WHERE scheduled_at < ?", [
    new Date(now.getTime() - INDIVIDUAL_BODY_RETENTION_MS).toISOString(),
  ]);
}

export async function findMessageSet(db: Db, personaKey: string): Promise<MessageSet | undefined> {
  const row = await db.get<{ messages: string }>(
    "SELECT messages FROM nudge_message_sets WHERE persona_key = ?",
    [personaKey],
  );
  return row ? (JSON.parse(row.messages) as MessageSet) : undefined;
}

/** 文面セットを保存する。最新の 1 件だけを残す（仮定 A15） */
export async function saveMessageSet(db: Db, personaKey: string, messages: MessageSet, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM nudge_message_sets");
    await tx.run("INSERT INTO nudge_message_sets (persona_key, messages, created_at) VALUES (?, ?, ?)", [
      personaKey,
      JSON.stringify(messages),
      now.toISOString(),
    ]);
  });
}
