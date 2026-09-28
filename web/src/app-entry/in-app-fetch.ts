/**
 * 製品版（Tauri アプリ）の web のエントリが、描画より前にグローバルの
 * `fetch` を包む関数（機能仕様 docs/features/tauri-in-app-runtime.md
 * クリティカル設計決定1・S2「/api の振り向け」）。
 *
 * 同一オリジンかつパスが `/api` または `/api/` で始まる要求だけを
 * `app.fetch(new Request(input, init))` へ渡す（方法・ヘッダ・本文・
 * `signal` は `Request` を経由してそのまま保たれる）。それ以外
 * （別オリジン・`/api` 以外のパス）は元の `fetch` へそのまま渡す。
 *
 * 依存（`app`／元の `fetch`／`location`）はすべて引数で受け取る純粋な形
 * にし、テスト可能にする（実際の注入はアプリのエントリ〔`main.tsx`〕が
 * `window.fetch`／`window.location` を渡して行う）。
 */

/** `createCoreApp` が返す Hono アプリの、この関数が必要とする最小限の形
 * （`Hono.fetch` は `Request` を受け取り `Promise<Response>` を返す）。 */
export interface InAppFetchTarget {
  // Hono の `Hono.fetch` は同期に解決できる応答を `Promise` で包まずに返す
  // ことがあるため、戻り値の型は `Response | Promise<Response>`
  // （`Hono<...>["fetch"]` の実際の型に合わせる）。
  fetch(request: Request): Response | Promise<Response>;
}

const API_PATH_PREFIX = "/api";

function isApiPath(pathname: string): boolean {
  return pathname === API_PATH_PREFIX || pathname.startsWith(`${API_PATH_PREFIX}/`);
}

/**
 * 同一オリジンの判定に使う最小限の `Location` の形。self-review
 * （code-reviewer, PLAUSIBLE）: `origin` の文字列同値比較は、`tauri:`
 * のような「特別でない」スキーム（WHATWG URL の "special scheme" 一覧に
 * 無い）では**必ず** `"null"`（不透明オリジンの直列化表現）になり、
 * スキームの異なる不透明オリジンどうしも `"null" === "null"` で一致して
 * しまう（実測: `new URL("tauri://localhost/x").origin === "null"`、
 * `new URL("other://localhost/x").origin === "null"` も同じ）。
 * `protocol`（末尾コロンを含む）と `host`（ホスト名＋ポート）を個別に
 * 比較すれば、この不透明オリジンどうしの取りこぼしが起きない
 * （`URL#protocol`/`URL#host` はスキームが "special" かどうかに関係なく
 * 構造的に取れる）。
 */
export type InAppFetchLocation = Pick<Location, "protocol" | "host">;

function isSameOrigin(url: URL, location: InAppFetchLocation): boolean {
  return url.protocol === location.protocol && url.host === location.host;
}

/**
 * `input`（`RequestInfo | URL`）が指す URL を、`Request` を作らずに求める。
 * self-review（code-reviewer, PLAUSIBLE）: 判定のためだけに毎回
 * `new Request(input, init)` を組み立てると、`input` が本文を持つ既存の
 * `Request` インスタンスだったとき、その本文が「使用済み」になってしまい
 * （`Request`/`Body` は一度しか読めない）、後続で `originalFetch(input,
 * init)` へ**同じ** `input` を渡す素通しの経路が失敗する。素通しに回る間は
 * `input`/`init` を一切消費しないようにする。
 */
function resolveRequestUrl(input: RequestInfo | URL, base: string): URL {
  if (input instanceof Request) {
    return new URL(input.url);
  }
  return new URL(input.toString(), base);
}

/**
 * 与えられた `app`／元の `fetch`／`location` を束ねた、包んだ `fetch` を返す。
 *
 * 振り分けの判定だけは {@link resolveRequestUrl} で `input`/`init` を消費
 * せずに行う。`/api` へ振り向けると決まった要求だけ `new Request(input,
 * init)` を組み立てて `app` へ渡す（方法・ヘッダ・本文・`signal` を保つ）。
 * それ以外は受け取った `input`／`init` そのものを元の `fetch` へ渡す
 * （余計な正規化を経由させない）。
 */
export function installInAppApi(
  app: InAppFetchTarget,
  originalFetch: typeof fetch,
  location: InAppFetchLocation,
): typeof fetch {
  const base = `${location.protocol}//${location.host}`;

  return async function inAppFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = resolveRequestUrl(input, base);

    if (isSameOrigin(url, location) && isApiPath(url.pathname)) {
      // `input` が相対パスの文字列（画面の各 API モジュールが使う実際の
      // 形。例: `fetch("/api/tasks")`）だと、`new Request(input, init)` は
      // 実行環境の「現在の設定オブジェクトの API 基点 URL」に頼って解決する
      // — ブラウザ／WebView では暗黙に解決できるが、テスト環境
      // （Node の素の `Request`）にはその基点が無く例外になる。`input` が
      // `Request` のときはそのまま渡す（`init` による上書き・本文・
      // ヘッダを保つ）。それ以外（文字列・`URL`）のときは、既に解決済みの
      // 絶対 URL（`url`）を渡す——基点に頼らず確実に解決できる。
      return app.fetch(new Request(input instanceof Request ? input : url, init));
    }

    return originalFetch(input, init);
  };
}
