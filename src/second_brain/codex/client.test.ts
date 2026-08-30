import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

import { SECOND_BRAIN_DEFAULTS } from "../config.js";
import {
  classifyCodexFailureKind,
  CodexCliClient,
  CodexCliError,
  parseJsonEvents,
  summarizeCodexFailure,
  summarizeCodexTimeout
} from "./client.js";

test("CodexCliClient.buildExecArgs applies repo defaults for semantic runs", () => {
  // The wrapper should bake in our preferred execution shape so future
  // compiler code does not hand-assemble Codex shell commands each time.
  const client = new CodexCliClient({
    projectRoot: "/repo",
    defaultModel: "gpt-5.4"
  });

  const args = client.buildExecArgs({
    prompt: "Analyze this batch.",
    outputLastMessagePath: "/tmp/last.txt",
    outputSchemaPath: "/tmp/schema.json"
  });

  assert.deepEqual(args, [
    "exec",
    "-C",
    "/repo",
    "--ephemeral",
    "-s",
    "read-only",
    "-m",
    "gpt-5.4",
    "-c",
    `model_reasoning_effort="${SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort}"`,
    "--color",
    SECOND_BRAIN_DEFAULTS.codex.defaultColor,
    "--output-schema",
    "/tmp/schema.json",
    "-o",
    "/tmp/last.txt",
    "-"
  ]);
  assert.equal(args.includes("Analyze this batch."), false);
});

test("CodexCliClient.execStructured parses the final message instead of scraping stdout", () => {
  // Real Codex stdout contains banners and token summaries. The wrapper should
  // trust the dedicated output file so structured results stay stable.
  const client = new CodexCliClient({
    projectRoot: "/repo",
    runner: (_command, args, options) => {
      assert.equal(options.input, "Return schema output.");
      assert.equal(args.includes("Return schema output."), false);
      assert.equal(args.at(-1), "-");
      const outputPathIndex = args.indexOf("-o");
      const outputPath = args[outputPathIndex + 1];
      writeFileSync(outputPath, '{"answer":"SCHEMA_OK"}\n', "utf8");

      return {
        pid: 1,
        output: [],
        stdout: Buffer.from("codex\n{\"answer\":\"SCHEMA_OK\"}\n"),
        stderr: Buffer.from(""),
        status: 0,
        signal: null
      };
    }
  });

  const result = client.execStructured<{ answer: string }>({
    prompt: "Return schema output.",
    outputSchemaPath: "/tmp/schema.json"
  });

  assert.equal(result.finalMessage, '{"answer":"SCHEMA_OK"}');
  assert.deepEqual(result.parsed, { answer: "SCHEMA_OK" });
  assert.equal(result.exitCode, 0);
});

test("CodexCliClient.exec keeps prompts on stdin and redacts diagnostic echoes", () => {
  const prompt = "PRIVATE_PROMPT_HEADER\nPrivate payload with a \"quoted value\".";
  const client = new CodexCliClient({
    projectRoot: "/repo",
    runner: (_command, args, options) => {
      assert.equal(options.input, prompt);
      assert.equal(args.includes(prompt), false);
      assert.equal(args.at(-1), "-");

      const outputPath = args[args.indexOf("-o") + 1];
      writeFileSync(outputPath, "OK\n", "utf8");
      return {
        pid: 1,
        output: [],
        stdout: Buffer.from(`${JSON.stringify({ type: "diagnostic", text: prompt })}\n`),
        stderr: Buffer.from(`echoed prompt:\n${prompt}`),
        status: 0,
        signal: null
      };
    }
  });

  const result = client.exec({ prompt, jsonOutput: true });

  assert.equal(result.args.includes(prompt), false);
  assert.doesNotMatch(result.stdout, /PRIVATE_PROMPT_HEADER|Private payload/);
  assert.doesNotMatch(result.stderr, /PRIVATE_PROMPT_HEADER|Private payload/);
  assert.match(result.stdout, /\[prompt redacted\]/);
  assert.match(result.stderr, /\[prompt redacted\]/);
  assert.deepEqual(result.jsonEvents, [
    { type: "diagnostic", text: "[prompt redacted]" }
  ]);
});

test("CodexCliClient.exec redacts prompts from failure diagnostics", () => {
  const prompt = "PRIVATE_FAILURE_PROMPT";
  const client = new CodexCliClient({
    projectRoot: "/repo",
    runner: (_command, args, options) => {
      assert.equal(options.input, prompt);
      assert.equal(args.includes(prompt), false);
      return {
        pid: 1,
        output: [],
        stdout: Buffer.from(`error: ${prompt}`),
        stderr: Buffer.from(`permission denied while handling ${prompt}`),
        status: 1,
        signal: null
      };
    }
  });

  assert.throws(
    () => client.exec({ prompt }),
    (error: unknown) => {
      assert.ok(error instanceof CodexCliError);
      assert.doesNotMatch(error.stdout, /PRIVATE_FAILURE_PROMPT/);
      assert.doesNotMatch(error.stderr, /PRIVATE_FAILURE_PROMPT/);
      assert.doesNotMatch(error.message, /PRIVATE_FAILURE_PROMPT/);
      assert.match(error.stdout, /\[prompt redacted\]/);
      assert.match(error.stderr, /\[prompt redacted\]/);
      return true;
    }
  );
});

test("CodexCliClient.buildExecArgs preserves explicit non-Git writable overrides", () => {
  const client = new CodexCliClient({ projectRoot: "/repo" });
  const args = client.buildExecArgs({
    prompt: "Explicit override.",
    outputLastMessagePath: "/tmp/last.txt",
    sandboxMode: "workspace-write",
    skipGitRepoCheck: true
  });

  assert.equal(args.includes("--skip-git-repo-check"), true);
  assert.equal(args[args.indexOf("-s") + 1], "workspace-write");
  assert.equal(args.includes("Explicit override."), false);
  assert.equal(args.at(-1), "-");
});

test("CodexCliClient.exec captures JSONL events when requested", () => {
  const client = new CodexCliClient({
    projectRoot: "/repo",
    runner: (_command, args) => {
      const outputPath = args[args.indexOf("-o") + 1];
      writeFileSync(outputPath, "OK\n", "utf8");

      return {
        pid: 1,
        output: [],
        stdout: Buffer.from(
          [
            '{"type":"thread.started","thread_id":"thread-1"}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}'
          ].join("\n")
        ),
        stderr: Buffer.from(""),
        status: 0,
        signal: null
      };
    }
  });

  const result = client.exec({
    prompt: "Reply with exactly: OK",
    jsonOutput: true
  });

  assert.equal(result.finalMessage, "OK");
  assert.deepEqual(result.jsonEvents.map((event) => event.type), [
    "thread.started",
    "item.completed"
  ]);
});

test("CodexCliClient.exec surfaces exit failures with stderr context", () => {
  const client = new CodexCliClient({
    projectRoot: "/repo",
    runner: () => ({
      pid: 1,
      output: [],
      stdout: Buffer.from(""),
      stderr: Buffer.from("permission denied"),
      status: 1,
      signal: null
    })
  });

  try {
    client.exec({
      prompt: "Fail please."
    });
    assert.fail("Expected CodexCliClient.exec to throw.");
  } catch (error) {
    assert.ok(error instanceof CodexCliError);
    assert.equal(error.kind, "other");
    assert.match(error.message, /permission denied/);
  }
});

test("CodexCliClient.exec summarizes output-buffer termination without dumping stderr", () => {
  const bufferError = Object.assign(new Error("spawnSync codex ENOBUFS"), {
    code: "ENOBUFS"
  });
  const client = new CodexCliClient({
    projectRoot: "/repo",
    runner: () => ({
      pid: 1,
      output: [],
      stdout: Buffer.from(""),
      stderr: Buffer.from(`tool output ${"x".repeat(20_000)}`),
      status: null,
      signal: "SIGTERM",
      error: bufferError
    })
  });

  assert.throws(
    () => client.exec({ prompt: "Fail with too much tool output." }),
    (error: unknown) => {
      assert.ok(error instanceof CodexCliError);
      assert.match(error.message, /output buffer/);
      assert.ok(error.message.length < 300);
      assert.doesNotMatch(error.message, /xxxxxxxxxx/);
      return true;
    }
  );
});

test("CodexCliClient.exec retries one timed-out Codex call", () => {
  let callCount = 0;
  const timeoutError = Object.assign(new Error("spawn timed out"), {
    code: "ETIMEDOUT"
  });
  const client = new CodexCliClient({
    projectRoot: "/repo",
    defaultTimeoutMs: 1234,
    defaultTimeoutAttemptLimit: 2,
    runner: (_command, args, options) => {
      callCount += 1;
      assert.equal(options.timeout, 1234);

      if (callCount === 1) {
        return {
          pid: 1,
          output: [],
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          status: null,
          signal: "SIGTERM",
          error: timeoutError
        };
      }

      const outputPath = args[args.indexOf("-o") + 1];
      writeFileSync(outputPath, "OK\n", "utf8");
      return {
        pid: 2,
        output: [],
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        status: 0,
        signal: null
      };
    }
  });

  const result = client.exec({
    prompt: "Retry once."
  });

  assert.equal(callCount, 2);
  assert.equal(result.finalMessage, "OK");
});

test("CodexCliClient.exec stops after two timed-out Codex calls", () => {
  let callCount = 0;
  const timeoutError = Object.assign(new Error("spawn timed out"), {
    code: "ETIMEDOUT"
  });
  const client = new CodexCliClient({
    projectRoot: "/repo",
    defaultTimeoutMs: 60_000,
    defaultTimeoutAttemptLimit: 2,
    runner: () => {
      callCount += 1;
      return {
        pid: callCount,
        output: [],
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        status: null,
        signal: "SIGTERM",
        error: timeoutError
      };
    }
  });

  try {
    client.exec({
      prompt: "Timeout twice."
    });
    assert.fail("Expected timeout to throw.");
  } catch (error) {
    assert.ok(error instanceof CodexCliError);
    assert.equal(error.kind, "timeout");
    assert.equal(error.exitCode, 124);
    assert.equal(callCount, 2);
    assert.match(error.message, /2 attempts/);
  }
});

test("CodexCliClient.execSemanticBatch keeps the project defaults in one place", () => {
  const client = new CodexCliClient({
    projectRoot: "/repo",
    runner: (_command, args) => {
      const outputPath = args[args.indexOf("-o") + 1];
      writeFileSync(outputPath, '{"nodes":[]}\n', "utf8");

      return {
        pid: 1,
        output: [],
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        status: 0,
        signal: null
      };
    }
  });

  const result = client.execSemanticBatch<{ nodes: unknown[] }>({
    prompt: "Propose thought nodes.",
    outputSchemaPath: "/tmp/thought-nodes.schema.json"
  });

  assert.deepEqual(result.parsed, { nodes: [] });
  assert.equal(result.args.includes("--ephemeral"), true);
  assert.equal(result.args.includes("--skip-git-repo-check"), false);
  assert.equal(result.args[result.args.indexOf("-s") + 1], "read-only");
  assert.equal(result.args.includes("--output-schema"), true);
  assert.equal(result.args.includes("--color"), true);
  assert.equal(result.args.at(-1), "-");
});

test("parseJsonEvents ignores non-JSON lines in mixed stdout", () => {
  const events = parseJsonEvents([
    "OpenAI Codex v0.121.0",
    '{"type":"thread.started"}',
    "tokens used",
    '{"type":"turn.completed"}'
  ].join("\n"));

  assert.deepEqual(events, [
    { type: "thread.started" },
    { type: "turn.completed" }
  ]);
});

test("classifyCodexFailureKind detects auth failures", () => {
  assert.equal(
    classifyCodexFailureKind("", "Please run codex login again."),
    "auth"
  );
  assert.equal(
    classifyCodexFailureKind("", "Unauthorized: session expired, please sign in again."),
    "auth"
  );
});

test("classifyCodexFailureKind detects quota failures", () => {
  assert.equal(
    classifyCodexFailureKind("usage limit reached", ""),
    "quota"
  );
});

test("summarizeCodexFailure keeps auth errors actionable without dumping the full prompt", () => {
  const message = summarizeCodexFailure(
    "auth",
    "user\nVery long prompt payload that should not be repeated here.",
    [
      "OpenAI Codex v0.121.0",
      "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
      "Please sign in again."
    ].join("\n"),
    1
  );

  assert.match(message, /Run `codex login` manually/);
  assert.match(message, /401 Unauthorized/);
  assert.match(message, /Please sign in again/);
  assert.doesNotMatch(message, /Very long prompt payload/);
  assert.doesNotMatch(message, /2026-04-20T09:22:02/);
});

test("summarizeCodexTimeout reports attempts and minutes", () => {
  assert.equal(
    summarizeCodexTimeout(60 * 60 * 1000, 2),
    "Codex execution timed out after 2 attempts of 60 minutes each. Rerun later to resume from the last successful checkpoint."
  );
});
