import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

test("netease service source does not import the blocking upstream API package", () => {
  const source = fs.readFileSync("src/services/neteaseService.ts", "utf8");
  assert.equal(source.includes("NeteaseCloudMusicApi"), false);
});

test("production dependencies avoid blocking server packages", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { dependencies?: Record<string, string> };
  assert.equal(pkg.dependencies?.NeteaseCloudMusicApi, undefined);
  assert.equal(pkg.dependencies?.express, undefined);
  assert.equal(pkg.dependencies?.qrcode, "^1.5.4");
});

test("qr creation returns quickly without loading the upstream API package", async () => {
  const script = `
    import { NeteaseService } from "./dist/src/services/neteaseService.js";
    const service = new NeteaseService();
    const result = await service.qrCreate("codex-test-key");
    console.log(JSON.stringify({
      code: result.code,
      nestedCode: result.data?.code ?? null,
      hasImage: String(result.data?.qrimg || "").startsWith("data:image/png;base64,")
    }));
  `;

  const result = await runNodeScript(script, 1500);
  assert.equal(result.timedOut, false, result.stderr || "qr creation timed out");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    code: 200,
    nestedCode: null,
    hasImage: true,
  });
});

function runNodeScript(script: string, timeoutMs: number): Promise<{ code: number | null; stderr: string; stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr, stdout, timedOut });
    });
  });
}
