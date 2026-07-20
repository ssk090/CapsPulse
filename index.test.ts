import assert from "node:assert/strict";
import test from "node:test";
import { cmuxSurfaceIsFocused, isAssistantWaitingForInput, ledModeForEvent } from "./index.ts";

test("agent settled only fast-blinks when input was requested", () => {
  assert.equal(ledModeForEvent("agent_start"), "blink");
  assert.equal(ledModeForEvent("agent_settled", true), "fastBlink");
  assert.equal(ledModeForEvent("agent_settled", false), "solid");
});

test("a final assistant question requests input", () => {
  assert.equal(
    isAssistantWaitingForInput({ role: "assistant", content: [{ type: "text", text: "Which city?" }] }),
    true,
  );
  assert.equal(
    isAssistantWaitingForInput({ role: "assistant", content: [{ type: "text", text: "Task complete." }] }),
    false,
  );
});

test("user input exits the fast-blink state", () => {
  assert.equal(ledModeForEvent("input"), "solid");
});

test("only the focused cmux terminal surface controls the LED", () => {
  const identify = JSON.stringify({ focused: { surface_id: "focused-surface" } });
  assert.equal(cmuxSurfaceIsFocused(identify, "focused-surface"), true);
  assert.equal(cmuxSurfaceIsFocused(identify, "background-surface"), false);
});

test("invalid cmux output permits single-terminal fallback", () => {
  assert.equal(cmuxSurfaceIsFocused("not json", "surface"), undefined);
});
