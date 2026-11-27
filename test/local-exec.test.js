import test from "node:test";
import assert from "node:assert/strict";
import { isCommandBlocked, server } from "../index.js";

test("local_exec blocks destructive and privileged shell commands", () => {
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

test("local_exec allows safe read and inspection commands", () => {
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

test("registers local_exec tool on MCP server", () => {
  assert.ok(server, "MCP server should be defined");
  if (server._registeredTools) {
    assert.ok(server._registeredTools.local_exec, "local_exec tool should be registered");
  }
});
