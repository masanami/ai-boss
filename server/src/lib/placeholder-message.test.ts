import { describe, expect, it } from "vitest";
import { buildPlaceholderMessage } from "./placeholder-message.js";

describe("buildPlaceholderMessage", () => {
  it("returns a message that includes the given service name", () => {
    expect(buildPlaceholderMessage("ai-boss server")).toBe(
      "ai-boss server placeholder",
    );
  });
});
