import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("README explains the product without unverified marketing claims", async () => {
  const readme = await read("README.md");

  assert.match(readme, /Claude Code.*orchestrat/i);
  assert.match(readme, /Ctrl\+G/);
  assert.match(readme, /same (Claude Code )?session/i);
  assert.match(readme, /Apache-2\.0/);
  assert.match(readme, /not affiliated with or endorsed by OpenAI or Anthropic/i);
  assert.match(readme, /Windows.*macOS.*Linux/is);
  assert.match(readme, /read-only/i);
  assert.match(readme, /prompts?.*not persisted/i);
  assert.doesNotMatch(readme, /revolutionary|game-changing|10x|magic|seamless/i);
  assert.doesNotMatch(readme, /npm install -g codex-fleet-cc/i);
});

test("README marks unfinished installation and platform support truthfully", async () => {
  const readme = await read("README.md");

  assert.match(readme, /development preview/i);
  assert.match(readme, /not yet published/i);
  assert.match(readme, /Windows[^\n]*proven/i);
  assert.match(readme, /macOS[^\n]*(CI|release gate)/i);
  assert.match(readme, /Linux[^\n]*(CI|release gate)/i);
});
