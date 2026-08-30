import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function collectTests(directory) {
  const tests = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) tests.push(...collectTests(target));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) tests.push(target);
  }
  return tests;
}

const tests = collectTests(path.resolve("dist", "second_brain")).sort();
if (tests.length === 0) throw new Error("No compiled test files found under dist/second_brain.");

const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
