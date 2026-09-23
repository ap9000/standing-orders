import { describe, expect, test } from "vitest";
import { claudeStreamReader, mateToolLabel, partialAnswerText } from "./mate-progress.js";

describe("live reply progress", () => {
  test("the reply's text is read from a structured answer as it is written", () => {
    expect(partialAnswerText("")).toBeNull();
    expect(partialAnswerText('{"calls": [], "text": "late"')).toBeNull();
    expect(partialAnswerText('{"text": "')).toBe("");
    expect(partialAnswerText('{"text": "Two tasks')).toBe("Two tasks");
    expect(partialAnswerText('{ "text" : "Line one\\nsaid \\"hi\\" \\u00e9')).toBe('Line one\nsaid "hi" é');
    // An escape cut off at the end waits for the next chunk.
    expect(partialAnswerText('{"text": "tab\\')).toBe("tab");
    expect(partialAnswerText('{"text": "x\\u00')).toBe("x");
    expect(partialAnswerText('{"text": "done", "calls": [{"id": "c1"}]}')).toBe("done");
  });

  test("the Claude stream reader follows only the structured answer, across any chunking", () => {
    const lines = [
      { type: "system", subtype: "init" },
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "private" } } },
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "StructuredOutput", input: {} } } },
      ...['{"text": "He', 'llo', ' there", "calls": []}'].map(partial => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: partial } } })),
      { type: "result", subtype: "success" },
    ].map(line => JSON.stringify(line)).join("\n") + "\n";
    for (const size of [1, 7, 64, lines.length]) {
      const seen: string[] = [];
      const read = claudeStreamReader(text => seen.push(text));
      for (let at = 0; at < lines.length; at += size) read(lines.slice(at, at + size));
      expect(seen).toEqual(["He", "Hello", "Hello there"]);
    }
  });

  test("tools read as plain words", () => {
    expect(mateToolLabel("get_task")).toBe("Reading the task");
    expect(mateToolLabel("propose_review")).toBe("Preparing a card for you to confirm");
    expect(mateToolLabel("something_new")).toBe("Working");
  });
});
