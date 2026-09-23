// WebView 内で server/src/detection の *.test.ts をそのまま走らせるための最小 vitest 互換シム（スパイク専用）。
// 検知エンジンのテストが使う API（describe / it / it.each / beforeEach / afterEach / expect の一部 / vi.spyOn）だけを実装する。

type Fn = () => unknown | Promise<unknown>;
interface Suite { name: string; children: (Suite | Test)[]; before: Fn[]; after: Fn[] }
interface Test { name: string; fn: Fn }

const root: Suite = { name: "", children: [], before: [], after: [] };
let current = root;

export function describe(name: string, body: () => void) {
  const suite: Suite = { name, children: [], before: [], after: [] };
  current.children.push(suite);
  const parent = current;
  current = suite;
  try { body(); } finally { current = parent; }
}

function format(template: string, args: unknown[]): string {
  let i = 0;
  return template.replace(/%[sdioj]/g, () => String(args[i++]));
}

function each(register: (name: string, fn: Fn) => void) {
  return (cases: readonly unknown[]) => (name: string, fn: (...args: any[]) => unknown) => {
    for (const c of cases) {
      const args = Array.isArray(c) ? c : [c];
      register(format(name, args), () => fn(...args));
    }
  };
}

function registerTest(name: string, fn: Fn) { current.children.push({ name, fn }); }
export const it = Object.assign(registerTest, { each: each(registerTest) });
export const test = it;
describe.each = each((name, fn) => describe(name, fn as () => void));
// 条件が偽ならスイートを登録しない（件数は skipped として数える）
export let skippedSuites: string[] = [];
describe.runIf = (cond: boolean) => (name: string, body: () => void) => {
  if (cond) describe(name, body); else skippedSuites.push(name);
};

export function beforeEach(fn: Fn) { current.before.push(fn); }
export function afterEach(fn: Fn) { current.after.push(fn); }

function isObject(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null; }
function equals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => equals(x, b[i]));
  }
  if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every((x) => b.has(x));
  if (a instanceof Map && b instanceof Map) return a.size === b.size && [...a].every(([k, v]) => equals(v, b.get(k)));
  if (isObject(a) && isObject(b)) {
    // vitest の toEqual と同じく undefined のプロパティは無視する
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!equals(a[k], b[k])) return false;
    return true;
  }
  return false;
}

interface Spy { calls: unknown[][]; restore: () => void; mockRestore: () => void }
const spies: Spy[] = [];

function show(v: unknown) { try { return JSON.stringify(v); } catch { return String(v); } }

function matchers(actual: any, negate: boolean) {
  const check = (pass: boolean, msg: string) => {
    if (pass === negate) throw new Error(`${negate ? "not " : ""}${msg}`);
  };
  return {
    toBe: (e: unknown) => check(Object.is(actual, e), `expected ${show(actual)} to be ${show(e)}`),
    toEqual: (e: unknown) => check(equals(actual, e), `expected ${show(actual)} to equal ${show(e)}`),
    toBeNull: () => check(actual === null, `expected ${show(actual)} to be null`),
    toBeUndefined: () => check(actual === undefined, `expected ${show(actual)} to be undefined`),
    toBeGreaterThan: (e: number) => check(actual > e, `expected ${actual} > ${e}`),
    toHaveLength: (n: number) => check(actual?.length === n, `expected length ${actual?.length} to be ${n}`),
    toContain: (e: unknown) => check(typeof actual === "string" ? actual.includes(e as string) : [...actual].includes(e), `expected ${show(actual)} to contain ${show(e)}`),
    toContainEqual: (e: unknown) => check([...actual].some((x) => equals(x, e)), `expected ${show(actual)} to contain equal ${show(e)}`),
    toMatch: (e: RegExp | string) => check(typeof e === "string" ? actual.includes(e) : e.test(actual), `expected ${show(actual)} to match ${e}`),
    toHaveBeenCalled: () => check((actual as Spy).calls.length > 0, "expected spy to have been called"),
  };
}

export function expect(actual: unknown) {
  return { ...matchers(actual, false), not: matchers(actual, true) };
}

export const vi = {
  spyOn(obj: any, method: string) {
    const original = obj[method];
    const spy: Spy & { mockImplementation: (f: (...a: unknown[]) => unknown) => Spy } = {
      calls: [],
      restore: () => { obj[method] = original; },
      mockRestore: () => { obj[method] = original; },
      mockImplementation(f) { impl = f; return spy; },
    };
    let impl: (...a: unknown[]) => unknown = original.bind(obj);
    obj[method] = (...args: unknown[]) => { spy.calls.push(args); return impl(...args); };
    spies.push(spy);
    return spy;
  },
  restoreAllMocks() { while (spies.length) spies.pop()!.restore(); },
};

export interface TestResult { name: string; ok: boolean; error?: string }

export async function runAll(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  async function walk(suite: Suite, path: string[], befores: Fn[], afters: Fn[]) {
    const b = [...befores, ...suite.before];
    const a = [...suite.after, ...afters];
    for (const child of suite.children) {
      if ("fn" in child) {
        const name = [...path, child.name].join(" > ");
        try {
          for (const f of b) await f();
          await child.fn();
          results.push({ name, ok: true });
        } catch (e) {
          results.push({ name, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          for (const f of a) await f();
          vi.restoreAllMocks();
        }
      } else {
        await walk(child, [...path, child.name], b, a);
      }
    }
  }
  await walk(root, [], [], []);
  return results;
}
