import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { SECOND_BRAIN_DEFAULTS } from "../config.js";

/**
 * Supported Codex sandbox modes exposed by the local CLI.
 */
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/**
 * Reasoning effort levels currently advertised by the installed Codex model metadata.
 */
export type CodexReasoningEffort = "low" | "medium" | "high" | "hard" | "xhigh";

/**
 * Machine-readable event emitted by `codex exec --json`.
 *
 * The CLI can emit several event shapes, so the wrapper keeps this permissive
 * and lets higher layers inspect extra fields when needed.
 */
export type CodexJsonEvent = {
  type: string;
  [key: string]: unknown;
};

/**
 * High-level failure classes that matter to the compiler orchestration layer.
 */
export type CodexFailureKind = "auth" | "quota" | "timeout" | "other";

/**
 * Input shape for one `codex exec` call.
 *
 * Defaults are intentionally biased toward our semantic compiler workflow:
 * ephemeral runs, explicit working directory, and deterministic final-message capture.
 */
export type CodexExecRequest = {
  prompt: string;
  workingDir?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  sandboxMode?: CodexSandboxMode;
  outputSchemaPath?: string;
  skipGitRepoCheck?: boolean;
  ephemeral?: boolean;
  jsonOutput?: boolean;
  color?: "always" | "never" | "auto";
  extraWritableDirs?: string[];
  configOverrides?: Record<string, string | number | boolean>;
  timeoutMs?: number;
  timeoutAttemptLimit?: number;
};

/**
 * Full result of one Codex CLI execution after the wrapper extracts the final
 * assistant message from the temporary output file.
 */
export type CodexExecResult = {
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  finalMessage: string;
  jsonEvents: CodexJsonEvent[];
};

/**
 * Error raised when the local Codex CLI fails.
 *
 * The compiler layer needs more than a raw stderr string because auth failures
 * and quota failures have different recovery paths.
 */
export class CodexCliError extends Error {
  readonly kind: CodexFailureKind;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(options: {
    kind: CodexFailureKind;
    message: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  }) {
    super(options.message);
    this.name = "CodexCliError";
    this.kind = options.kind;
    this.exitCode = options.exitCode;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
  }
}

type SpawnRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptions
) => SpawnSyncReturns<Buffer>;

/**
 * Project-specific wrapper around `codex exec`.
 *
 * This is the place where we centralize the invocation shape we want for
 * semantic compilation, rather than scattering raw shell calls across the repo.
 */
export class CodexCliClient {
  readonly binaryPath: string;
  readonly projectRoot: string;
  readonly defaultModel: string | null;
  readonly defaultSandboxMode: CodexSandboxMode;
  readonly defaultReasoningEffort: CodexReasoningEffort;
  readonly defaultEphemeral: boolean;
  readonly defaultSkipGitRepoCheck: boolean;
  readonly defaultJsonOutput: boolean;
  readonly defaultColor: "always" | "never" | "auto" | undefined;
  readonly defaultConfigOverrides: Record<string, string | number | boolean>;
  readonly defaultTimeoutMs: number;
  readonly defaultTimeoutAttemptLimit: number;

  private readonly runner: SpawnRunner;

  constructor(options: {
    binaryPath?: string;
    projectRoot: string;
    defaultModel?: string | null;
    defaultSandboxMode?: CodexSandboxMode;
    defaultReasoningEffort?: CodexReasoningEffort;
    defaultEphemeral?: boolean;
    defaultSkipGitRepoCheck?: boolean;
    defaultJsonOutput?: boolean;
    defaultColor?: "always" | "never" | "auto";
    defaultConfigOverrides?: Record<string, string | number | boolean>;
    defaultTimeoutMs?: number;
    defaultTimeoutAttemptLimit?: number;
    runner?: SpawnRunner;
  }) {
    this.binaryPath = options.binaryPath ?? SECOND_BRAIN_DEFAULTS.codex.binaryPath;
    this.projectRoot = options.projectRoot;
    this.defaultModel = options.defaultModel ?? SECOND_BRAIN_DEFAULTS.codex.defaultModel;
    this.defaultSandboxMode =
      options.defaultSandboxMode ?? SECOND_BRAIN_DEFAULTS.codex.defaultSandboxMode;
    this.defaultReasoningEffort =
      options.defaultReasoningEffort ?? SECOND_BRAIN_DEFAULTS.codex.defaultReasoningEffort;
    this.defaultEphemeral =
      options.defaultEphemeral ?? SECOND_BRAIN_DEFAULTS.codex.defaultEphemeral;
    this.defaultSkipGitRepoCheck =
      options.defaultSkipGitRepoCheck ?? SECOND_BRAIN_DEFAULTS.codex.defaultSkipGitRepoCheck;
    this.defaultJsonOutput =
      options.defaultJsonOutput ?? SECOND_BRAIN_DEFAULTS.codex.defaultJsonOutput;
    this.defaultColor = options.defaultColor ?? SECOND_BRAIN_DEFAULTS.codex.defaultColor;
    this.defaultConfigOverrides = {
      ...SECOND_BRAIN_DEFAULTS.codex.defaultConfigOverrides,
      ...(options.defaultConfigOverrides ?? {})
    };
    this.defaultTimeoutMs =
      options.defaultTimeoutMs ?? SECOND_BRAIN_DEFAULTS.codex.callTimeoutMs;
    this.defaultTimeoutAttemptLimit =
      options.defaultTimeoutAttemptLimit ?? SECOND_BRAIN_DEFAULTS.codex.timeoutAttemptLimit;
    this.runner = options.runner ?? spawnSync;
  }

  /**
   * Build the argv list for `codex exec` without running it.
   *
   * Keeping this logic explicit makes it easy to test argument shaping and to
   * evolve the semantic compiler contract without guessing what the shell call
   * would look like.
   */
  buildExecArgs(request: CodexExecRequest & { outputLastMessagePath: string }): string[] {
    const args = ["exec"];
    const workingDir = request.workingDir ?? this.projectRoot;

    args.push("-C", workingDir);

    if (request.ephemeral ?? this.defaultEphemeral) {
      args.push("--ephemeral");
    }

    if (request.skipGitRepoCheck ?? this.defaultSkipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }

    args.push("-s", request.sandboxMode ?? this.defaultSandboxMode);

    const model = request.model ?? this.defaultModel;
    if (model) {
      args.push("-m", model);
    }

    const reasoningEffort = request.reasoningEffort ?? this.defaultReasoningEffort;
    if (reasoningEffort) {
      args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    }

    const color = request.color ?? this.defaultColor;
    if (color) {
      args.push("--color", color);
    }

    if (request.jsonOutput ?? this.defaultJsonOutput) {
      args.push("--json");
    }

    if (request.outputSchemaPath) {
      args.push("--output-schema", request.outputSchemaPath);
    }

    for (const writableDir of request.extraWritableDirs ?? []) {
      args.push("--add-dir", writableDir);
    }

    const configOverrides = {
      ...this.defaultConfigOverrides,
      ...(request.configOverrides ?? {})
    };

    for (const [key, value] of Object.entries(configOverrides)) {
      const encodedValue =
        typeof value === "string" ? JSON.stringify(value) : value.toString();
      args.push("-c", `${key}=${encodedValue}`);
    }

    // The wrapper always captures the last agent message into a temp file so
    // higher layers can consume structured output reliably without parsing CLI banners.
    args.push("-o", request.outputLastMessagePath);
    // A lone dash tells `codex exec` to read the prompt from stdin. Never put
    // corpus content in process argv, where local process inspectors can see it.
    args.push("-");
    return args;
  }

  /**
   * Run one semantic analysis prompt and return both the raw CLI output and a
   * clean final assistant message.
   */
  exec(request: CodexExecRequest): CodexExecResult {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "second-brain-codex-"));
    const outputLastMessagePath = path.join(tempDir, "last-message.txt");

    try {
      const args = this.buildExecArgs({
        ...request,
        outputLastMessagePath
      });

      const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
      const timeoutAttemptLimit =
        request.timeoutAttemptLimit ?? this.defaultTimeoutAttemptLimit;
      let result: SpawnSyncReturns<Buffer> | null = null;
      let timeoutCount = 0;

      for (let attempt = 1; attempt <= timeoutAttemptLimit; attempt += 1) {
        rmSync(outputLastMessagePath, { force: true });
        result = this.runner(this.binaryPath, args, {
          cwd: request.workingDir ?? this.projectRoot,
          encoding: "buffer",
          input: request.prompt,
          timeout: timeoutMs
        });

        if (!isSpawnTimeout(result)) {
          break;
        }

        timeoutCount += 1;
        if (attempt >= timeoutAttemptLimit) {
          const stdout = redactPromptFromDiagnostics(
            result.stdout.toString("utf8"),
            request.prompt
          );
          const stderr = redactPromptFromDiagnostics(
            result.stderr.toString("utf8"),
            request.prompt
          );
          throw new CodexCliError({
            kind: "timeout",
            message: summarizeCodexTimeout(timeoutMs, timeoutCount),
            exitCode: 124,
            stdout,
            stderr
          });
        }
      }

      if (!result) {
        throw new Error("Codex execution did not start.");
      }

      const stdout = redactPromptFromDiagnostics(
        result.stdout.toString("utf8"),
        request.prompt
      );
      const stderr = redactPromptFromDiagnostics(
        result.stderr.toString("utf8"),
        request.prompt
      );
      const finalMessage = existsSync(outputLastMessagePath)
        ? readFileSync(outputLastMessagePath, "utf8").trim()
        : "";

      if (typeof result.status !== "number") {
        const spawnError = result.error as NodeJS.ErrnoException | undefined;
        const reason = spawnError?.code ?? result.signal ?? "unknown reason";
        const message = spawnError?.code === "ENOBUFS"
          ? "Codex execution exceeded the local process output buffer and was terminated. Rerun to resume from the last successful checkpoint."
          : `Codex execution ended without an exit status (${reason}). Rerun to resume from the last successful checkpoint.`;
        throw new CodexCliError({
          kind: "other",
          message,
          exitCode: 1,
          stdout,
          stderr
        });
      }

      const execResult: CodexExecResult = {
        args,
        exitCode: result.status,
        stdout,
        stderr,
        finalMessage,
        jsonEvents: request.jsonOutput ? parseJsonEvents(stdout) : []
      };

      if (execResult.exitCode !== 0) {
        const kind = classifyCodexFailureKind(stdout, stderr);
        throw new CodexCliError({
          kind,
          message: summarizeCodexFailure(kind, stdout, stderr, execResult.exitCode),
          exitCode: execResult.exitCode,
          stdout,
          stderr
        });
      }

      return execResult;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Run Codex with a JSON Schema contract and parse the final assistant message
   * into a typed object.
   */
  execStructured<T>(request: CodexExecRequest & { outputSchemaPath: string }): CodexExecResult & { parsed: T } {
    const result = this.exec(request);
    return {
      ...result,
      parsed: JSON.parse(result.finalMessage) as T
    };
  }

  /**
   * Convenience path for the semantic compiler.
   *
   * This keeps the repo's intended defaults in one place so later compiler code
   * can simply provide prompt + schema + optional overrides.
   */
  execSemanticBatch<T>(request: {
    prompt: string;
    outputSchemaPath: string;
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    workingDir?: string;
    extraWritableDirs?: string[];
    configOverrides?: Record<string, string | number | boolean>;
    sandboxMode?: CodexSandboxMode;
  }): CodexExecResult & { parsed: T } {
    return this.execStructured<T>({
      prompt: request.prompt,
      outputSchemaPath: request.outputSchemaPath,
      model: request.model,
      reasoningEffort: request.reasoningEffort,
      workingDir: request.workingDir,
      extraWritableDirs: request.extraWritableDirs,
      configOverrides: request.configOverrides,
      sandboxMode: request.sandboxMode ?? this.defaultSandboxMode,
      color: this.defaultColor,
      jsonOutput: this.defaultJsonOutput,
      ephemeral: this.defaultEphemeral,
      skipGitRepoCheck: this.defaultSkipGitRepoCheck
    });
  }
}

/**
 * Parse JSONL event output from `codex exec --json`.
 */
export function parseJsonEvents(stdout: string): CodexJsonEvent[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .map((line) => JSON.parse(line) as CodexJsonEvent);
}

/**
 * Best-effort classification of Codex CLI failures into orchestration-relevant buckets.
 */
export function classifyCodexFailureKind(stdout: string, stderr: string): CodexFailureKind {
  const haystack = `${stdout}\n${stderr}`.toLowerCase();

  if (
    /(not logged in|logged out|codex login|authentication|auth error|credential|credentials|expired session|session expired|login required|please log in|please login|sign in|unauthorized|401)/i.test(
      haystack
    )
  ) {
    return "auth";
  }

  if (
    /(rate limit|quota|usage limit|limit reached|too many requests|retry later|429)/i.test(
      haystack
    )
  ) {
    return "quota";
  }

  return "other";
}

function isSpawnTimeout(result: SpawnSyncReturns<Buffer>): boolean {
  const error = result.error as NodeJS.ErrnoException | undefined;
  return error?.code === "ETIMEDOUT";
}

const PROMPT_REDACTION = "[prompt redacted]";

/**
 * Remove an exact prompt echo from diagnostic channels before they leave the
 * wrapper. Codex JSONL represents the prompt as a JSON-escaped string, while
 * process errors can reproduce it as raw text or one prefixed line at a time.
 */
function redactPromptFromDiagnostics(diagnostics: string, prompt: string): string {
  if (!prompt) {
    return diagnostics;
  }

  const promptLines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const rawCandidates = Array.from(new Set([prompt, ...promptLines]))
    .sort((left, right) => right.length - left.length);

  let redacted = diagnostics;
  for (const candidate of rawCandidates) {
    const jsonCandidate = JSON.stringify(candidate);
    const jsonBody = jsonCandidate.slice(1, -1);

    // Replace a complete JSON string first so JSONL diagnostics stay parseable.
    redacted = redacted.replaceAll(jsonCandidate, JSON.stringify(PROMPT_REDACTION));
    redacted = redacted.replaceAll(candidate, PROMPT_REDACTION);
    if (jsonBody !== candidate) {
      redacted = redacted.replaceAll(jsonBody, PROMPT_REDACTION);
    }
  }

  return redacted;
}

export function summarizeCodexTimeout(timeoutMs: number, attempts: number): string {
  const minutes = Math.round(timeoutMs / 60_000);
  return `Codex execution timed out after ${attempts} attempts of ${minutes} minutes each. Rerun later to resume from the last successful checkpoint.`;
}

/**
 * Extract only the lines that help the operator recover from a failed Codex run.
 *
 * The raw stderr can contain the whole prompt payload, which makes checkpoints
 * noisy and hard to scan. Keep the actionable auth/quota details and drop the rest.
 */
export function summarizeCodexFailure(
  kind: CodexFailureKind,
  stdout: string,
  stderr: string,
  exitCode: number
): string {
  const combined = `${stderr}\n${stdout}`;
  const lines = combined
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\d{4}-\d{2}-\d{2}T[^ ]+\s+ERROR\s+[^:]+:\s*/, "")
        .trim()
    )
    .filter((line) => line.length > 0);

  const relevantPatterns =
    kind === "auth"
      ? [
          /unauthorized/i,
          /401/i,
          /codex login/i,
          /sign in/i,
          /log in/i,
          /authentication/i,
          /expired session/i,
          /session expired/i,
          /missing bearer/i
        ]
      : kind === "quota"
        ? [
            /rate limit/i,
            /quota/i,
            /usage limit/i,
            /limit reached/i,
            /too many requests/i,
            /429/i,
            /retry/i
          ]
        : [/error[: ]/i, /unexpected status/i, /failed/i, /permission denied/i];

  const detailLines = Array.from(
    new Set(lines.filter((line) => relevantPatterns.some((pattern) => pattern.test(line))))
  ).slice(0, kind === "auth" ? 2 : 4);

  const header =
    kind === "auth"
      ? "Codex authentication failed. Run `codex login` manually and retry."
      : kind === "quota"
        ? "Codex quota or rate limit reached. Wait, then rerun to resume from the last successful batch."
        : kind === "timeout"
          ? "Codex execution timed out. Rerun later to resume from the last successful checkpoint."
          : `Codex execution failed with exit code ${exitCode}.`;

  if (detailLines.length === 0) {
    return header;
  }

  return `${header}\n${detailLines.join("\n")}`;
}
