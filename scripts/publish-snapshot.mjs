import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { put } from "@vercel/blob";

const execFileAsync = promisify(execFile);
const cwd = new URL("..", import.meta.url).pathname;

function env(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return value;
}

async function main() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error("BLOB_READ_WRITE_TOKEN is required");
  }

  const blobPath = env("SNAPSHOT_BLOB_PATH", "scanner/latest.json");
  const quoteSizeUsdc = env("SNAPSHOT_QUOTE_SIZE_USDC", "1000");
  const limit = env("SNAPSHOT_LIMIT", "200");
  const dashboardLimit = env("SNAPSHOT_DASHBOARD_LIMIT", "100");
  const minQueueMultiple = env("SNAPSHOT_MIN_QUEUE_MULTIPLE", "2");
  const minApr = env("SNAPSHOT_MIN_APR", "0");

  const args = [
    "run",
    "--quiet",
    "--bin",
    "snapshot",
    "--",
    "--quote-size-usdc",
    quoteSizeUsdc,
    "--limit",
    limit,
    "--dashboard-limit",
    dashboardLimit,
    "--min-queue-multiple",
    minQueueMultiple,
    "--min-apr",
    minApr
  ];

  const { stdout, stderr } = await execFileAsync("cargo", args, {
    cwd,
    maxBuffer: 1024 * 1024 * 64
  });

  if (stderr) {
    process.stderr.write(stderr);
  }

  if (!stdout.trim()) {
    throw new Error("snapshot generator returned empty output");
  }

  const snapshot = JSON.parse(stdout);
  const uploaded = await put(blobPath, stdout, {
    access: "public",
    contentType: "application/json; charset=utf-8",
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    token
  });

  console.log(
    JSON.stringify(
      {
        pathname: uploaded.pathname,
        url: uploaded.url,
        generatedAt: snapshot.meta?.generatedAt ?? null,
        sourceVersion: snapshot.meta?.sourceVersion ?? null,
        dashboardRows: Array.isArray(snapshot.dashboard?.rows) ? snapshot.dashboard.rows.length : 0,
        singleSidedRows: Array.isArray(snapshot.opportunities?.singleSided?.rows)
          ? snapshot.opportunities.singleSided.rows.length
          : 0,
        twoSidedRows: Array.isArray(snapshot.opportunities?.twoSided?.rows)
          ? snapshot.opportunities.twoSided.rows.length
          : 0
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
