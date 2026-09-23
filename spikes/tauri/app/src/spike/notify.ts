import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, cancel, pending, Schedule, type Options } from "@tauri-apps/plugin-notification";

// sendNotification() は window.Notification 経由の fire-and-forget で失敗が握りつぶされるため、同じコマンドを直接 invoke して結果・エラーを受け取る
const errors: string[] = [];
async function sendNotification(options: Options) {
  try {
    await invoke("plugin:notification|notify", { options });
  } catch (e) {
    errors.push(`id=${options.id}: ${String(e)}`);
  }
}

// 項目 4: 予約通知（予約・取り消し・再予約・上限 64 件）
export async function ensurePermission() {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  return granted;
}

// 回避策: plugin-notification 2.4.0 の iOS 実装は "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'" を timeZone 未設定の DateFormatter で
// パースするため、UTC の ISO 文字列が端末ローカル時刻として解釈される（JST では 9 時間早くなり pastScheduledTime で拒否）。
// 壁時計のローカル時刻を「Z 付き」で渡すよう、UTC オフセット分ずらした Date を渡す。
function localWallClockAsUtc(d: Date) { return new Date(d.getTime() - d.getTimezoneOffset() * 60_000); }
const at = (secondsFromNow: number) => Schedule.at(localWallClockAsUtc(new Date(Date.now() + secondsFromNow * 1000)));

export async function runNotifyBasic() {
  const granted = await ensurePermission();
  if (!granted) return { ok: false, granted };
  // 予約 → 取り消し → 再予約
  errors.length = 0;
  await sendNotification({ id: 101, title: "ai-boss spike", body: "取り消される予約（届いたら NG）", schedule: at(40) });
  await sendNotification({ id: 102, title: "ai-boss spike", body: "再予約前（届いたら NG）", schedule: at(45) });
  await new Promise((r) => setTimeout(r, 500));
  const afterSchedule = (await pending()).map((p) => p.id);
  await cancel([101]);
  await sendNotification({ id: 102, title: "ai-boss spike", body: "再予約後の通知（アプリ終了中に届けば OK）", schedule: at(60) });
  await new Promise((r) => setTimeout(r, 500));
  const afterReschedule = await pending();
  return { ok: errors.length === 0 && afterReschedule.length === 1, errors: [...errors], granted, afterSchedule, afterReschedule: afterReschedule.map((p) => ({ id: p.id, title: p.title, body: p.body, schedule: p.schedule })) };
}

export async function runNotifyLimit() {
  const granted = await ensurePermission();
  if (!granted) return { ok: false, granted };
  await cancel((await pending()).map((p) => p.id));
  errors.length = 0;
  for (let i = 0; i < 70; i++) {
    await sendNotification({ id: 1000 + i, title: "limit probe", body: `#${i}`, schedule: at(3600 + i * 60) });
  }
  await new Promise((r) => setTimeout(r, 1500));
  const ids = (await pending()).map((p) => p.id).sort((a, b) => a - b);
  await cancel(ids);
  return { ok: errors.length === 0, errors: errors.slice(0, 5), errorCount: errors.length, requested: 70, pendingCount: ids.length, firstId: ids[0], lastId: ids[ids.length - 1] };
}
