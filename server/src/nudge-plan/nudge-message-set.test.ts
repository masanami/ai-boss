import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONA_SETTINGS } from "../boss/persona-prompt.js";
import {
  buildMessageSetLlmRequest,
  chooseVariantIndex,
  fillMessageTemplate,
  parseMessageSet,
} from "./nudge-message-set.js";
import { validMessageSetJson } from "./replan-test-fixtures.js";

describe("parseMessageSet", () => {
  it("reads a complete 8 x 3 x 3 JSON response", () => {
    const set = parseMessageSet(JSON.stringify(validMessageSetJson()));
    expect(set?.todo_stall[2][1]).toBe("{task}を進めろ todo_stall L2 v1");
    expect(Object.keys(set ?? {})).toHaveLength(8);
  });

  it("tolerates text around the JSON object", () => {
    expect(parseMessageSet(`以下です\n${JSON.stringify(validMessageSetJson())}\n以上`)).not.toBeNull();
  });

  it("rejects a response missing a rule", () => {
    const json = validMessageSetJson();
    delete json.silence;
    expect(parseMessageSet(JSON.stringify(json))).toBeNull();
  });

  it("rejects a response missing a level", () => {
    const json = validMessageSetJson();
    delete json.silence?.["3"];
    expect(parseMessageSet(JSON.stringify(json))).toBeNull();
  });

  it("rejects a level with fewer than 3 variants", () => {
    const json = validMessageSetJson();
    json.silence!["1"] = ["a", "b"];
    expect(parseMessageSet(JSON.stringify(json))).toBeNull();
  });

  it("rejects an empty message (including one that is empty after HTML normalization)", () => {
    const json = validMessageSetJson();
    json.silence!["1"] = ["a", "", "c"];
    expect(parseMessageSet(JSON.stringify(json))).toBeNull();
    json.silence!["1"] = ["a", "<p></p>", "c"];
    expect(parseMessageSet(JSON.stringify(json))).toBeNull();
  });

  it("rejects a non-JSON response", () => {
    expect(parseMessageSet("文面を作れませんでした")).toBeNull();
    expect(parseMessageSet("{not json}")).toBeNull();
  });
});

describe("fillMessageTemplate / chooseVariantIndex", () => {
  it("replaces every {task} and {time}", () => {
    expect(fillMessageTemplate("{task}を{time}に。{task}だ", "資料作成", "2026-09-14 10:00")).toBe(
      "資料作成を2026-09-14 10:00に。資料作成だ",
    );
  });

  it("does not replace {time} inside the substituted task title", () => {
    expect(fillMessageTemplate("{task}を{time}に", "{time}の資料", "10:30")).toBe("{time}の資料を10:30に");
  });

  it("chooses the same variant for the same reservation key, within 0..2", () => {
    const key = "nudge|silence|1|2026-09-14T01:00:00.000Z";
    expect(chooseVariantIndex(key)).toBe(chooseVariantIndex(key));
    for (const k of ["a", "bb", "ccc", key]) {
      expect([0, 1, 2]).toContain(chooseVariantIndex(k));
    }
  });
});

describe("buildMessageSetLlmRequest", () => {
  it("includes the persona and the rule/level names", () => {
    const request = buildMessageSetLlmRequest("claude-sonnet-5", {
      ...DEFAULT_PERSONA_SETTINGS,
      name: "スミス",
      customInstructions: "語尾は「である」",
    });
    expect(request.system).toContain("スミス");
    expect(request.system).toContain("語尾は「である」");
    const user = String(request.messages[0]?.content);
    expect(user).toContain("todo_stall: 未着手");
    expect(user).toContain("L3（強い催促）");
  });
});
