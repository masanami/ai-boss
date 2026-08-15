/**
 * TaskCard ↔ TaskBoard 間でネイティブ HTML5 Drag and Drop の dataTransfer に
 * 載せるタスク id の mime type（Issue #122）。
 *
 * `@dnd-kit` 等のライブラリを追加せず、ネイティブ DnD API のみで実現する方式を
 * 採用した理由は Issue #122 の「方式選定」参照。
 */
export const TASK_DRAG_DATA_TYPE = "application/x-ai-boss-task-id";
