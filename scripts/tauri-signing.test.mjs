/**
 * 署名つきのビルドの組み立て（#581 S3・機能仕様
 * docs/features/secure-transport-byok.md 受入基準（S3）S3-G1〜S3-G7）。
 * `node --test scripts/`（`npm run test:scripts`）で実行する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { planSignedBuild, runSignedBuild } from "./tauri-signing.mjs";

const tauriAppDir = "/repo/native/tauri-app";
const validEnv = { APPLE_SIGNING_IDENTITY: "Apple Development: Test (ABCDE12345)", APPLE_TEAM_ID: "ABCDE12345" };

function fakeDeps() {
  const record = { mkdirs: [], files: new Map(), runs: [], errors: [] };
  const deps = {
    mkdir: (dir) => record.mkdirs.push(dir),
    writeFile: (path, content) => record.files.set(path, content),
    run: (command, args, cwd) => {
      record.runs.push({ command, args, cwd });
      return 0;
    },
    logError: (message) => record.errors.push(message),
  };
  return { deps, record };
}

function assertRefusedBeforeBuilding(env) {
  const { deps, record } = fakeDeps();
  const status = runSignedBuild(env, { tauriAppDir }, deps);
  assert.notEqual(status, 0);
  assert.deepEqual(record.runs, []);
  assert.equal(record.files.size, 0);
}

test("S3-G1: APPLE_SIGNING_IDENTITY が無いと、ビルドを始めずに 0 以外で終わる", () => {
  assertRefusedBeforeBuilding({ APPLE_TEAM_ID: "ABCDE12345" });
});

test("S3-G2: APPLE_TEAM_ID が無いと、ビルドを始めずに 0 以外で終わる", () => {
  assertRefusedBeforeBuilding({ APPLE_SIGNING_IDENTITY: validEnv.APPLE_SIGNING_IDENTITY });
});

test("S3-G3: APPLE_TEAM_ID が英大文字と数字の 10 文字でないと、ビルドを始めずに 0 以外で終わる", () => {
  for (const teamId of ["abc", "ABCDEFGHIJK", "abcde12345", "ABCDE-1234"]) {
    assertRefusedBeforeBuilding({ ...validEnv, APPLE_TEAM_ID: teamId });
  }
});

test("S3-G4: entitlements の keychain-access-groups は <チーム ID>.dev.aiboss.app の 1 要素だけ", () => {
  const plan = planSignedBuild(validEnv, { tauriAppDir });
  const entitlements = plan.files.find((file) => file.path.endsWith("entitlements.plist")).content;
  const groups = [...entitlements.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  assert.deepEqual(groups, ["ABCDE12345.dev.aiboss.app"]);
  assert.equal(entitlements.match(/<key>/g).length, 1);
  assert.match(entitlements, /<key>keychain-access-groups<\/key>/);
});

test("S3-G5: 生成するファイルは native/tauri-app/target/ の下に置く", () => {
  const plan = planSignedBuild(validEnv, { tauriAppDir });
  for (const file of plan.files) {
    assert.ok(file.path.startsWith(join(tauriAppDir, "target") + "/"), file.path);
  }
});

test("S3-G6: Tauri のビルドへ entitlements と signingIdentity を指定する", () => {
  const { deps, record } = fakeDeps();
  assert.equal(runSignedBuild(validEnv, { tauriAppDir, extraArgs: ["--debug"] }, deps), 0);
  const [run] = record.runs;
  assert.deepEqual(run.args.slice(0, 5), ["@tauri-apps/cli", "build", "--bundles", "app", "--config"]);
  assert.equal(run.args.at(-1), "--debug");
  const config = JSON.parse(record.files.get(run.args[5]));
  const entitlementsPath = [...record.files.keys()].find((path) => path.endsWith("entitlements.plist"));
  assert.equal(config.bundle.macOS.entitlements, entitlementsPath);
  assert.equal(config.bundle.macOS.signingIdentity, validEnv.APPLE_SIGNING_IDENTITY);
  assert.equal(config.bundle.macOS.files, undefined);
});

test("S3-G7: APPLE_PROVISIONING_PROFILE を指定すると embedded.provisionprofile として指定する", () => {
  const plan = planSignedBuild({ ...validEnv, APPLE_PROVISIONING_PROFILE: "/tmp/dev.provisionprofile" }, { tauriAppDir });
  const config = JSON.parse(plan.files.find((file) => file.path.endsWith(".json")).content);
  assert.deepEqual(config.bundle.macOS.files, { "embedded.provisionprofile": "/tmp/dev.provisionprofile" });
});
