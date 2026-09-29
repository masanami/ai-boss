/**
 * 署名つきの Tauri のビルドの組み立て（#581 S3・機能仕様
 * docs/features/secure-transport-byok.md クリティカル設計決定 9・オーナーの
 * 決定 Q7・受入基準（S3）S3-G1〜S3-G7）。
 *
 * 製品版のキーはデータ保護キーチェーンに入れるため、キーを登録するには
 * `keychain-access-groups` の entitlement を付けて署名した `.app` が要る
 * （未署名・ad-hoc 署名では登録が OSStatus -34018 になる）。署名 ID・チーム ID
 * （・任意でプロビジョニングプロファイル）は環境変数で受け取り、**リポジトリの
 * ファイルに書かない**。entitlements と Tauri の設定の上書きは、ビルドのたびに
 * Git の管理外（`native/tauri-app/target/signing/`）へ生成する。
 *
 * 副作用（ファイルの書き込み・Tauri の CLI の起動）は `runSignedBuild` の
 * 依存として受け取り、テストで差し替える（`scripts/tauri-signing.test.mjs`）。
 */
import { join } from "node:path";

/** アプリの識別子（`native/tauri-app/tauri.conf.json` の `identifier`）。 */
export const APP_IDENTIFIER = "dev.aiboss.app";

const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

export class SigningConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "SigningConfigError";
  }
}

/**
 * 環境変数から署名の設定を読む。足りない・形が違うときは SigningConfigError。
 * @param {Record<string, string | undefined>} env
 */
export function readSigningConfig(env) {
  const signingIdentity = env.APPLE_SIGNING_IDENTITY?.trim();
  if (!signingIdentity) {
    throw new SigningConfigError("APPLE_SIGNING_IDENTITY（Apple Development の証明書の名前）を環境変数で指定してください");
  }
  const teamId = env.APPLE_TEAM_ID?.trim();
  if (!teamId) {
    throw new SigningConfigError("APPLE_TEAM_ID（チーム ID）を環境変数で指定してください");
  }
  if (!TEAM_ID_PATTERN.test(teamId)) {
    throw new SigningConfigError("APPLE_TEAM_ID は英大文字と数字の 10 文字で指定してください");
  }
  const provisioningProfile = env.APPLE_PROVISIONING_PROFILE?.trim() || undefined;
  return { signingIdentity, teamId, provisioningProfile };
}

function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `keychain-access-groups` だけを持つ entitlements（plist）。 */
export function buildEntitlementsPlist(teamId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>keychain-access-groups</key>
  <array>
    <string>${escapeXml(`${teamId}.${APP_IDENTIFIER}`)}</string>
  </array>
</dict>
</plist>
`;
}

/** Tauri のビルドへ渡す設定の上書き（`--config`）。 */
export function buildTauriConfigOverride({ signingIdentity, provisioningProfile }, entitlementsPath) {
  return {
    bundle: {
      macOS: {
        signingIdentity,
        entitlements: entitlementsPath,
        ...(provisioningProfile ? { files: { "embedded.provisionprofile": provisioningProfile } } : {}),
      },
    },
  };
}

/**
 * 署名つきのビルドを計画する（書き込むファイルと Tauri の CLI の引数）。
 * @param {Record<string, string | undefined>} env
 * @param {{ tauriAppDir: string, extraArgs?: string[] }} options
 */
export function planSignedBuild(env, { tauriAppDir, extraArgs = [] }) {
  const config = readSigningConfig(env);
  const signingDir = join(tauriAppDir, "target", "signing");
  const entitlementsPath = join(signingDir, "entitlements.plist");
  const configPath = join(signingDir, "tauri.signing.conf.json");
  return {
    signingDir,
    files: [
      { path: entitlementsPath, content: buildEntitlementsPlist(config.teamId) },
      { path: configPath, content: `${JSON.stringify(buildTauriConfigOverride(config, entitlementsPath), null, 2)}\n` },
    ],
    command: "npx",
    args: ["@tauri-apps/cli", "build", "--bundles", "app", "--config", configPath, ...extraArgs],
    cwd: tauriAppDir,
  };
}

/**
 * 署名つきのビルドを実行し、終了コードを返す。設定が足りなければ Tauri の
 * ビルドを始めずに 1 を返す。
 * @param {Record<string, string | undefined>} env
 * @param {{ tauriAppDir: string, extraArgs?: string[] }} options
 * @param {{ mkdir: (dir: string) => void, writeFile: (path: string, content: string) => void,
 *   run: (command: string, args: string[], cwd: string) => number, logError: (message: string) => void }} deps
 */
export function runSignedBuild(env, options, deps) {
  let plan;
  try {
    plan = planSignedBuild(env, options);
  } catch (error) {
    if (error instanceof SigningConfigError) {
      deps.logError(error.message);
      return 1;
    }
    throw error;
  }
  deps.mkdir(plan.signingDir);
  for (const file of plan.files) {
    deps.writeFile(file.path, file.content);
  }
  return deps.run(plan.command, plan.args, plan.cwd);
}
