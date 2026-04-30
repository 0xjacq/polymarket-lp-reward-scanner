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

function envInteger(name, fallback, { min = 0 } = {}) {
  const raw = env(name, String(fallback));
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function countRows(snapshot, dataset) {
  return Array.isArray(snapshot.opportunities?.[dataset]?.rows)
    ? snapshot.opportunities[dataset].rows.length
    : 0;
}

function validateSnapshotContract(snapshot, label) {
  const generatedAt = snapshot?.meta?.generatedAt;
  if (typeof generatedAt !== "string" || !generatedAt.trim()) {
    throw new Error(`[snapshot:publish] ${label} snapshot is missing meta.generatedAt`);
  }

  if (!Array.isArray(snapshot?.dashboard?.rows)) {
    throw new Error(`[snapshot:publish] ${label} snapshot is missing dashboard.rows`);
  }

  for (const dataset of ["neutral", "extreme"]) {
    if (!Array.isArray(snapshot?.opportunities?.[dataset]?.rows)) {
      throw new Error(
        `[snapshot:publish] ${label} snapshot is missing opportunities.${dataset}.rows`
      );
    }
  }
}

async function verifyPublishedSnapshot(url, snapshot, attempts, backoffMs) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`verification fetch failed with status ${response.status}`);
      }

      const verifiedSnapshot = JSON.parse(await response.text());
      validateSnapshotContract(verifiedSnapshot, "published");

      const generatedAt = verifiedSnapshot.meta.generatedAt;
      const neutralRows = countRows(verifiedSnapshot, "neutral");
      const extremeRows = countRows(verifiedSnapshot, "extreme");
      const expectedNeutralRows = countRows(snapshot, "neutral");
      const expectedExtremeRows = countRows(snapshot, "extreme");

      if (generatedAt !== snapshot.meta.generatedAt) {
        throw new Error(
          `verification mismatch on generatedAt: expected ${snapshot.meta.generatedAt}, got ${generatedAt}`
        );
      }
      if (
        neutralRows !== expectedNeutralRows ||
        extremeRows !== expectedExtremeRows
      ) {
        throw new Error(
          `verification mismatch on opportunity counts: expected neutral=${expectedNeutralRows}, extreme=${expectedExtremeRows}; got neutral=${neutralRows}, extreme=${extremeRows}`
        );
      }

      return {
        generatedAt,
        neutralRows,
        extremeRows
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(backoffMs * attempt);
      }
    }
  }

  throw new Error(
    `[snapshot:publish] published snapshot verification failed after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

async function runSnapshotWithRetry(args, attempts, backoffMs) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await execFileAsync("cargo", args, {
        cwd,
        maxBuffer: 1024 * 1024 * 64
      });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[snapshot:publish] snapshot generation attempt ${attempt}/${attempts} failed: ${message}`
      );

      const stderr =
        error && typeof error === "object" && "stderr" in error
          ? error.stderr
          : null;
      if (typeof stderr === "string" && stderr.trim()) {
        process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
      }

      if (attempt < attempts) {
        const waitMs = backoffMs * 2 ** (attempt - 1);
        console.error(
          `[snapshot:publish] retrying snapshot generation in ${waitMs}ms`
        );
        await sleep(waitMs);
      }
    }
  }

  throw new Error(
    `[snapshot:publish] snapshot generation failed after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
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
  const publishAttempts = envInteger("SNAPSHOT_PUBLISH_ATTEMPTS", 5, { min: 1 });
  const publishBackoffMs = envInteger("SNAPSHOT_PUBLISH_BACKOFF_MS", 2000, {
    min: 0
  });

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

  const { stdout, stderr } = await runSnapshotWithRetry(
    args,
    publishAttempts,
    publishBackoffMs
  );

  if (stderr) {
    process.stderr.write(stderr);
  }

  if (!stdout.trim()) {
    throw new Error("snapshot generator returned empty output");
  }

  const snapshot = JSON.parse(stdout);
  validateSnapshotContract(snapshot, "generated");
  const uploaded = await put(blobPath, stdout, {
    access: "public",
    contentType: "application/json; charset=utf-8",
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    token
  });
  const verification = await verifyPublishedSnapshot(
    uploaded.url,
    snapshot,
    publishAttempts,
    Math.max(500, publishBackoffMs)
  );

  console.log(
    JSON.stringify(
      {
        pathname: uploaded.pathname,
        url: uploaded.url,
        generatedAt: snapshot.meta?.generatedAt ?? null,
        sourceVersion: snapshot.meta?.sourceVersion ?? null,
        dashboardRows: Array.isArray(snapshot.dashboard?.rows) ? snapshot.dashboard.rows.length : 0,
        neutralRows: countRows(snapshot, "neutral"),
        extremeRows: countRows(snapshot, "extreme"),
        verifiedGeneratedAt: verification.generatedAt,
        verifiedNeutralRows: verification.neutralRows,
        verifiedExtremeRows: verification.extremeRows
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
