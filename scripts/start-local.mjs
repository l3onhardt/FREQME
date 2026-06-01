import net from "node:net";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const entry = "dist/src/server.js";
const host = process.env.HOST || "127.0.0.1";
const requestedPort = Number(process.env.PORT || 8000);

if (!existsSync(entry)) {
  console.error("Build output is missing. Run `npm run build` first.");
  process.exit(1);
}

const port = process.env.PORT ? requestedPort : await firstOpenPort(host, requestedPort, requestedPort + 20);
if (!port) {
  console.error(`No open local port found from ${requestedPort} to ${requestedPort + 20}.`);
  process.exit(1);
}

if (port !== requestedPort) {
  console.log(`Port ${requestedPort} is busy; starting FREQME on ${port}.`);
}

const child = spawn(process.execPath, [entry], {
  env: { ...process.env, HOST: host, PORT: String(port) },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

async function firstOpenPort(hostname, start, end) {
  for (let port = start; port <= end; port += 1) {
    if (await canListen(hostname, port)) return port;
  }
  return 0;
}

function canListen(hostname, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, hostname);
  });
}
