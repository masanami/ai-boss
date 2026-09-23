import { runAll, skippedSuites } from "../selftest/vitest-shim";

// 項目 6: server/src/detection の本体とテストを無改変で WebView（JavaScriptCore）上で実行する。
const testModules = import.meta.glob("../engine/detection/*.test.ts");

export async function runDetectionCheck() {
  const t0 = performance.now();
  for (const load of Object.values(testModules)) await load();
  const results = await runAll();
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    files: Object.keys(testModules).length,
    total: results.length,
    passed: results.length - failed.length,
    failed,
    skippedSuites,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    elapsedMs: Math.round(performance.now() - t0),
  };
}
