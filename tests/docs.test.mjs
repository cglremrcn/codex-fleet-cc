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

test("README explains Fleet navigation, same-task continuation, and GPT Image 2 lanes", async () => {
  const readme = await read("README.md");

  assert.match(readme, /↓ to manage.*Claude/is);
  assert.match(readme, /Ctrl\+G.*Fleet/is);
  assert.match(readme, /same Codex (task|thread)/i);
  assert.match(readme, /redundant.*approval/is);
  assert.match(readme, /GPT Image 2/i);
  assert.match(readme, /image\.generate.*image\.edit/is);
});

test("troubleshooting keeps broker ownership refusals safe and actionable", async () => {
  const guide = await read("docs/TROUBLESHOOTING.md");

  assert.match(guide, /ownership-mismatch/i);
  assert.match(guide, /Fleet did not terminate/i);
  assert.match(guide, /PID/i);
  assert.match(guide, /do not.*kill.*name/is);
});

test("operator docs cover exact contract transport, status recovery, and external browser limits", async () => {
  const [readme, guide, architecture] = await Promise.all([
    read("README.md"),
    read("docs/TROUBLESHOOTING.md"),
    read("ARCHITECTURE.md")
  ]);
  const combined = `${readme}\n${guide}\n${architecture}`;

  assert.match(combined, /UTF-8.*--contract|--contract.*UTF-8/is);
  assert.match(combined, /confirmationRef.*root/is);
  assert.match(combined, /Claude background (agent|task).*Fleet lane/is);
  assert.match(combined, /status --all/iu);
  assert.match(combined, /result --summary/iu);
  assert.match(combined, /post-send timeout.*do not.*(repeat|redispatch)/is);
  assert.match(combined, /interrupted.*reconcil/is);
  assert.match(combined, /Playwright.*profile.*concurrenc.*external limitation/is);
  assert.match(combined, /stale MCP/is);
  assert.match(combined, /two (update )?surfaces.*plugin.*runtime/is);
});

test("README distinguishes current release labels from historical live evidence", async () => {
  const readme = await read("README.md");

  assert.match(readme, /current Fleet source release.*v0\.2\.0/isu);
  assert.match(readme, /Claude Code v2\.1\.252/iu);
  assert.match(readme, /Codex CLI 0\.147\.0/iu);
  for (const match of readme.matchAll(/0\.1\.7/gu)) {
    const context = readme.slice(Math.max(0, match.index - 80), match.index + 100);
    assert.match(context, /historical|recording|field report/iu);
  }
});
