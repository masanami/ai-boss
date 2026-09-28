/**
 * 応答を返した後にも状態を変え続ける要求（SSE のチャット）が、その後始末まで
 * 含めて終わったことを `createCoreApp` の計画し直しの契機
 * （`onStateChangingRequest`・#585 S2）へ伝える受け渡し口。
 *
 * ストリームの終わりをストリームの側（`TransformStream` の `cancel` 等）で
 * 観測しない。`cancel` は Node の拡張で WKWebView（製品版の実行環境）の
 * `Transformer` には無く、しかも中止の通知はルートの後始末（中断メッセージの
 * 保存・実行中のツールの完了）より先に届く。ルートが自分の後始末の最後で
 * 解決する Promise をここへ預け、`createCoreApp` はその解決を待って通知する。
 *
 * 要求（`Request`）ごとに持つ。Node 組み込みに依存しない（コアのモジュール）。
 */
const pendingWork = new WeakMap<Request, Promise<unknown>>();

/** `work` が決着する（成功・失敗のどちらでも）まで、この要求の状態の変更が続くと預ける */
export function deferStateChangeNotice(request: Request, work: Promise<unknown>): void {
  pendingWork.set(request, work);
}

/** 預けられた後始末を取り出す（無ければ `undefined`。取り出すと消える） */
export function takeDeferredStateChange(request: Request): Promise<unknown> | undefined {
  const work = pendingWork.get(request);
  pendingWork.delete(request);
  return work;
}
