import test from "node:test";
import assert from "node:assert/strict";
import { isCommandBlocked, server } from "../index.js";

test("blocks destructive and privileged shell commands", () => {
  const dangerous = [
    "rm -rf /",
    "rm -fr ./dist",
    "sudo apt update",
    "git reset --hard HEAD~1",
    "git clean -fd",
    "dd if=/dev/zero of=/dev/sda"
  ];
  for (const cmd of dangerous) {
    assert.equal(isCommandBlocked(cmd), true, `Expected blocked: ${cmd}`);
  }
});

test("allows safe read and inspection commands", () => {
  const safe = [
    "ls -la",
    "git status -sb",
    "grep -rn 'TODO' ./src",
    "cat package.json"
  ];
  for (const cmd of safe) {
    assert.equal(isCommandBlocked(cmd), false, `Expected allowed: ${cmd}`);
  }
});

test("exports configured MCP server instance", () => {
  assert.ok(server, "MCP server should be defined");
});
