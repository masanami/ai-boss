#!/usr/bin/env node
// ai-boss 実行ドライバ（エージェント用ハーネス）
//
// 依存ゼロ: Chrome/Chromium を --headless で起動し、CDP（Chrome DevTools
// Protocol）を Node 組み込みの WebSocket で直接叩く。playwright を
// ai-boss の package.json に足さないための選択（プロダクト依存を汚さない）。
//
// 使い方は SKILL.md 参照。
//   node .claude/skills/run-ai-boss/driver.mjs smoke
//   node .claude/skills/run-ai-boss/driver.mjs serve
//   node .claude/skills/run-ai-boss/driver.mjs drive script.txt
//   node .claude/skills/run-ai-boss/driver.mjs drive -   (stdin)

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SKILL_DIR, "../../.."); // <repo>/.claude/skills/run-ai-boss -> <repo>
const OUT_DIR = process.env.AI_BOSS_DRIVER_OUT ?? join(REPO_ROOT, ".driver-out");

// 既定はオーナーの本番ポート/DB を絶対に踏まない値。
const PORT = Number(process.env.AI_BOSS_DRIVER_PORT ?? 8788);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = process.env.AI_BOSS_DRIVER_DB ?? join(OUT_DIR, "driver.db");

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];

function log(...a) {
  console.log(...a);
}

function die(msg) {
  console.error(`\n[driver] FATAL: ${msg}`);
  process.exit(1);
}

function resolveChrome() {
  if (process.env.AI_BOSS_DRIVER_CHROME) {
    if (!existsSync(process.env.AI_BOSS_DRIVER_CHROME)) {
      die(`AI_BOSS_DRIVER_CHROME が存在しない: ${process.env.AI_BOSS_DRIVER_CHROME}`);
    }
    return process.env.AI_BOSS_DRIVER_CHROME;
  }
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  // playwright のブラウザキャッシュを最後の砦にする（macOS）。
  const pwRoot = join(process.env.HOME ?? "", "Library/Caches/ms-playwright");
  if (existsSync(pwRoot)) {
    for (const d of readdirSync(pwRoot).sort().reverse()) {
      for (const rel of [
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "chrome-mac/headless_shell",
      ]) {
        const p = join(pwRoot, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  die("Chrome/Chromium が見つからない。AI_BOSS_DRIVER_CHROME で明示して。");
}

// ---------------------------------------------------------------- server

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * ビルド済み server を隔離設定で起動する。
 * - PORT / DB_PATH を専用値にして、オーナーの 8787 と server/data/ai-boss.db を守る
 * - LLM_BACKEND=api + ANTHROPIC_API_KEY 空 で LLM 経路を「即座に失敗する」状態にする。
 *   既定の claude-code バックエンドは本物の Claude Code を子プロセスで起動して
 *   サブスクリプション枠を消費するため、スモークでは絶対に踏ませない。
 */
function startServer() {
  const entry = join(REPO_ROOT, "server/dist/index.js");
  if (!existsSync(entry)) {
    die(`server/dist/index.js が無い。先に \`npm run build\` を実行して。`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const logPath = join(OUT_DIR, "server.log");
  writeFileSync(logPath, ""); // truncate
  const child = spawn(process.execPath, [entry], {
    cwd: join(REPO_ROOT, "server"),
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH,
      LLM_BACKEND: "api",
      ANTHROPIC_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (buf) => {
    try {
      appendFileSync(logPath, buf);
    } catch {
      /* ignore */
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", (code) => {
    if (code && code !== 0) log(`[driver] server exited code=${code} (log: ${logPath})`);
  });
  return { child, logPath };
}

// ---------------------------------------------------------------- CDP

class Cdp {
  constructor() {
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    this.sessionId = null;
  }

  static async launch() {
    const bin = resolveChrome();
    const userDataDir = mkdtempSync(join(tmpdir(), "ai-boss-driver-"));
    const proc = spawn(
      bin,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--hide-scrollbars",
        "--window-size=1280,900",
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    // Chrome は実ポートを user-data-dir/DevToolsActivePort に書く。
    const portFile = join(userDataDir, "DevToolsActivePort");
    const deadline = Date.now() + 30_000;
    let port = null;
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        const first = readFileSync(portFile, "utf8").split("\n")[0].trim();
        if (first) {
          port = Number(first);
          break;
        }
      }
      await sleep(100);
    }
    if (!port) die("Chrome の DevToolsActivePort が読めなかった（起動失敗）");

    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const cdp = new Cdp();
    cdp.proc = proc;
    cdp.bin = bin;
    await cdp.connect(ver.webSocketDebuggerUrl);

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    cdp.sessionId = sessionId;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    return cdp;
  }

  connect(url) {
    return new Promise((res, rej) => {
      if (typeof WebSocket !== "function") {
        die("この Node に global WebSocket が無い。Node 22 以上で実行して（node -v）。");
      }
      this.ws = new WebSocket(url);
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(new Error(`CDP 接続失敗: ${e?.message ?? e}`));
      this.ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
    });
  }

  onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { res, rej } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) rej(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? "")})`));
      else res(msg.result);
      return;
    }
    // イベント: コンソール・例外を集める
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params.args ?? [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? "")
        .join(" ");
      this.logs.push({ level: msg.params.type, text });
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      this.logs.push({
        level: "error",
        text: d.exception?.description ?? d.text ?? "uncaught exception",
      });
    } else if (msg.method === "Log.entryAdded") {
      this.logs.push({ level: msg.params.entry.level, text: msg.params.entry.text });
    }
  }

  send(method, params = {}) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (this.sessionId && !method.startsWith("Target.")) payload.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP timeout: ${method}`));
        }
      }, 60_000);
    });
  }

  /** ページ内で式を評価して値を返す（await 対応）。 */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        `eval 例外: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      );
    }
    return r.result.value;
  }

  async nav(url) {
    await this.send("Page.navigate", { url });
    // load を待つ（SPA は描画まで別途 wait-for で待つ）
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const st = await this.eval("document.readyState");
      if (st === "complete" || st === "interactive") return;
      await sleep(100);
    }
    throw new Error(`nav: readyState が complete にならない (${url})`);
  }

  /** "text=..." なら innerText 包含、それ以外は CSS セレクタとして待つ。 */
  async waitFor(target, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    const expr = target.startsWith("text=")
      ? `document.body && document.body.innerText.includes(${JSON.stringify(target.slice(5))})`
      : `!!document.querySelector(${JSON.stringify(target)})`;
    while (Date.now() < deadline) {
      if (await this.eval(expr)) return;
      await sleep(200);
    }
    throw new Error(`wait-for タイムアウト: ${target}`);
  }

  /** セレクタ or text= でクリック。text= はボタン/リンク/クリック可能要素から探す。 */
  async click(target) {
    // text= は「完全一致を優先し、無ければ部分一致」。ナビの「タスク」と
    // サイドパネルのラベル「着手するタスク」のように、部分一致だと別要素を
    // 掴む組み合わせが実際にあるため。
    const expr = target.startsWith("text=")
      ? `(() => {
           const t = ${JSON.stringify(target.slice(5))};
           const els = [...document.querySelectorAll('button,a,[role=button],summary,label,input[type=submit]')];
           const txt = e => (e.innerText || e.value || '').trim();
           const el = els.find(e => txt(e) === t) || els.find(e => txt(e).includes(t));
           if (!el) return 'NOTFOUND';
           el.scrollIntoView({block:'center'}); el.click(); return 'OK';
         })()`
      : `(() => {
           const el = document.querySelector(${JSON.stringify(target)});
           if (!el) return 'NOTFOUND';
           el.scrollIntoView({block:'center'}); el.click(); return 'OK';
         })()`;
    const r = await this.eval(expr);
    if (r !== "OK") throw new Error(`click: 要素が見つからない: ${target}`);
  }

  /**
   * React の controlled input に値を入れる。
   * el.value = x だけでは React の onChange が発火しないため、
   * ネイティブ setter を呼んでから input イベントを bubbles で投げる。
   */
  async fill(selector, value) {
    const r = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOTFOUND';
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      el.focus();
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`);
    if (r === "NOTFOUND") throw new Error(`fill: 要素が見つからない: ${selector}`);
    return r;
  }

  async screenshot(name = `shot-${Date.now()}`) {
    mkdirSync(OUT_DIR, { recursive: true });
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    const p = join(OUT_DIR, `${name}.png`);
    writeFileSync(p, Buffer.from(data, "base64"));
    log(`[driver] screenshot -> ${p}`);
    return p;
  }

  errors() {
    return this.logs.filter((l) => l.level === "error" || l.level === "severe");
  }

  async close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.proc?.kill("SIGTERM");
  }
}

// ---------------------------------------------------------------- script runner

async function runScript(cdp, lines) {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sp = line.indexOf(" ");
    const cmd = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? "" : line.slice(sp + 1).trim();
    log(`[driver] > ${line}`);
    switch (cmd) {
      case "nav":
        await cdp.nav(rest.startsWith("http") ? rest : BASE + (rest || "/"));
        break;
      case "wait-for":
        await cdp.waitFor(rest);
        break;
      case "click":
        await cdp.click(rest);
        break;
      case "fill": {
        // セレクタに空白が入る（例: form[aria-label="..."] input）ため、
        // シングルクォートで囲んだ場合はそれをセレクタ全体として扱う。
        let sel, val;
        if (rest.startsWith("'")) {
          const end = rest.indexOf("'", 1);
          if (end === -1) throw new Error(`fill: 閉じクォートが無い: ${rest}`);
          sel = rest.slice(1, end);
          val = rest.slice(end + 1).trim();
        } else {
          const i = rest.indexOf(" ");
          if (i === -1) throw new Error(`fill: 値が無い: ${rest}`);
          sel = rest.slice(0, i);
          val = rest.slice(i + 1);
        }
        await cdp.fill(sel, val);
        break;
      }
      case "screenshot":
        await cdp.screenshot(rest || undefined);
        break;
      case "eval":
        log("  =", JSON.stringify(await cdp.eval(rest)));
        break;
      case "text":
        log("  =", (await cdp.eval("document.body.innerText")).slice(0, Number(rest || 2000)));
        break;
      case "assert-text": {
        const ok = await cdp.eval(
          `document.body.innerText.includes(${JSON.stringify(rest)})`,
        );
        if (!ok) throw new Error(`assert-text 失敗: 画面に "${rest}" が無い`);
        log(`  ok: "${rest}" が画面にある`);
        break;
      }
      case "sleep":
        await sleep(Number(rest || 500));
        break;
      case "console":
        for (const l of cdp.logs) log(`  [${l.level}] ${l.text}`);
        break;
      case "api": {
        // api GET /api/tasks   |   api POST /api/tasks {"title":"x"}
        const [method, path, ...body] = rest.split(" ");
        const init = { method };
        if (body.length) {
          init.headers = { "content-type": "application/json" };
          init.body = body.join(" ");
        }
        const r = await fetch(BASE + path, init);
        const t = await r.text();
        log(`  ${method} ${path} -> ${r.status} ${t.slice(0, 500)}`);
        break;
      }
      default:
        throw new Error(`未知のコマンド: ${cmd}`);
    }
  }
}

// ---------------------------------------------------------------- modes

// 実ユーザー操作だけで完結する煙テスト（LLM を一切叩かない経路を選ぶ）。
// 画面の文字列・セレクタは web/src の aria-label / ラベル文言に対応する
// （data-testid はこのアプリに1つも無い）。
const SMOKE = `
# 1. SPA が描画され、SSE/health も通っていることを確認
nav /
wait-for h1
assert-text ai-boss
wait-for text=接続 OK
# LLM 非依存の空状態（ダッシュボードのボス文面は待たない: §Gotchas 参照）
wait-for text=今日のタスクはまだありません
screenshot 01-dashboard

# 2. タスクボードへ移動
click text=タスク
wait-for main[aria-label="タスクボード"]
wait-for form[aria-label="タスク作成"]
screenshot 02-taskboard

# 3. フォームから実際にタスクを作る（UI 操作のみ・LLM 不要）
fill 'form[aria-label="タスク作成"] input' driver smoke task
click text=追加

# 4. 未着手カラムにカードが出る＝サーバー往復＋再描画が成立している
wait-for text=driver smoke task
assert-text driver smoke task
eval document.querySelector('section[aria-label="未着手"]').innerText.includes('driver smoke task')
screenshot 03-task-created

# 5. サイドパネルの「今日のタスク」「進捗」にも反映される
assert-text 0 / 1 件完了（0%）
screenshot 04-side-panel
`;

async function main() {
  const mode = process.argv[2] ?? "smoke";

  if (mode === "serve") {
    const { child, logPath } = startServer();
    if (!(await waitForHttp(BASE))) die(`server が ${BASE} で応答しない（log: ${logPath}）`);
    log(`[driver] ai-boss 起動: ${BASE}`);
    log(`[driver]   DB   : ${DB_PATH}  (隔離・本番 DB ではない)`);
    log(`[driver]   log  : ${logPath}`);
    log(`[driver] Ctrl-C で停止`);
    process.on("SIGINT", () => {
      child.kill("SIGTERM");
      process.exit(0);
    });
    // server が落ちたらドライバも終わる（孤児のまま残さない）。
    await new Promise((res) => child.on("exit", res));
    return;
  }

  let lines;
  if (mode === "smoke") {
    // 毎回まっさらな DB から始める（前回の "driver smoke task" が残っていると
    // 件数アサーションが 0/1 → 0/2 とずれて落ちるため）。
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = DB_PATH + suffix;
      if (existsSync(p)) rmSync(p);
    }
    lines = SMOKE.split("\n");
  } else if (mode === "drive") {
    const src = process.argv[3];
    if (!src) die("drive にはスクリプトファイル（または - で stdin）が必要");
    const text = src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
    lines = text.split("\n");
  } else {
    die(`未知のモード: ${mode}（smoke | serve | drive）`);
  }

  const { child, logPath } = startServer();
  let cdp = null;
  let failure = null;
  try {
    if (!(await waitForHttp(BASE))) die(`server が ${BASE} で応答しない（log: ${logPath}）`);
    log(`[driver] server up: ${BASE} (DB: ${DB_PATH})`);
    cdp = await Cdp.launch();
    log(`[driver] chrome: ${cdp.bin}`);
    await runScript(cdp, lines);
  } catch (e) {
    failure = e;
  } finally {
    const errs = cdp ? cdp.errors() : [];
    if (errs.length) {
      log(`\n[driver] ブラウザ console error ${errs.length} 件:`);
      for (const e of errs) log(`  [${e.level}] ${e.text}`);
    }
    await cdp?.close();
    child.kill("SIGTERM");
    await sleep(300);
  }
  if (failure) {
    console.error(`\n[driver] FAILED: ${failure.message}`);
    console.error(`[driver] server log: ${logPath}`);
    process.exit(1);
  }
  log(`\n[driver] OK — スクリーンショット: ${OUT_DIR}`);
}

main().catch((e) => die(e.stack ?? e.message));
