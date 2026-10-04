/**
 * Android の器が自動バックアップ（クラウド）と端末間の転送を拒否していること
 * （#679 S1 のレビュー対応・ADR 0001・製品のバックアップ方式は未決＝#588）。
 * `node --test scripts/`（`npm run test:scripts`）で実行する。コミットされた manifest と規則のファイルを読む。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mainDir = fileURLToPath(new URL("../native/tauri-app/gen/android/app/src/main/", import.meta.url));
const manifest = readFileSync(`${mainDir}AndroidManifest.xml`, "utf8");
const rules = readFileSync(`${mainDir}res/xml/data_extraction_rules.xml`, "utf8");

/** コメントを除いた XML（コメント内の記述で検査が通らないように）。 */
function stripComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

/** `<application ...>` の開始タグの属性。 */
function applicationAttributes() {
  const tags = stripComments(manifest).match(/<application\b[^>]*>/g) ?? [];
  assert.equal(tags.length, 1, "<application> の開始タグがちょうど 1 つある");
  return Object.fromEntries([...tags[0].matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

test("<application> は android:allowBackup=\"false\" を明示する（Android 11 以前）", () => {
  assert.equal(applicationAttributes()["android:allowBackup"], "false");
});

test("<application> は android:dataExtractionRules で規則のファイルを指す（Android 12 以降）", () => {
  assert.equal(applicationAttributes()["android:dataExtractionRules"], "@xml/data_extraction_rules");
});

const domains = ["root", "file", "database", "sharedpref", "external"];

for (const section of ["cloud-backup", "device-transfer"]) {
  test(`<${section}> はすべてのドメインを除外し、何も含めない`, () => {
    const bodies = [...stripComments(rules).matchAll(new RegExp(`<${section}\\b[^>]*>([\\s\\S]*?)</${section}>`, "g"))];
    assert.equal(bodies.length, 1, `<${section}> がちょうど 1 つある`);
    const body = bodies[0][1];
    assert.doesNotMatch(body, /<include\b/, `<${section}> に <include> が無い`);
    const excluded = [...body.matchAll(/<exclude\b[^>]*\bdomain="([^"]*)"[^>]*\bpath="\."[^>]*\/>/g)].map((m) => m[1]);
    assert.deepEqual([...excluded].sort(), [...domains].sort());
  });
}
