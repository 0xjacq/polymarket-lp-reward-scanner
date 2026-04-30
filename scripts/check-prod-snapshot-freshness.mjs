const scannerUrl =
  process.env.SNAPSHOT_FRESHNESS_URL ??
  "https://polymarket-lp-reward-scanner.vercel.app/api/scanner?limit=1";

function fail(message, context = {}) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        checkedAt: new Date().toISOString(),
        url: scannerUrl,
        message,
        ...context
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}

async function main() {
  const response = await fetch(scannerUrl, { cache: "no-store" });
  if (!response.ok) {
    fail(`scanner fetch failed with status ${response.status}`);
    return;
  }

  const payload = await response.json();
  const meta = payload?.meta ?? null;
  if (!meta || typeof meta !== "object") {
    fail("scanner response is missing meta");
    return;
  }

  const generatedAt = typeof meta.generatedAt === "string" ? meta.generatedAt : null;
  const snapshotHealth =
    typeof meta.snapshotHealth === "string" ? meta.snapshotHealth : null;
  const snapshotAgeMs = Number(meta.snapshotAgeMs);
  const staleAfterMs = Number(meta.staleAfterMs);
  const warning = typeof meta.warning === "string" ? meta.warning : null;

  const logContext = {
    generatedAt,
    snapshotHealth,
    snapshotAgeMs: Number.isFinite(snapshotAgeMs) ? snapshotAgeMs : null,
    staleAfterMs: Number.isFinite(staleAfterMs) ? staleAfterMs : null,
    warning
  };

  if (!generatedAt || Number.isNaN(new Date(generatedAt).getTime())) {
    fail("meta.generatedAt is missing or invalid", logContext);
    return;
  }
  if (!snapshotHealth) {
    fail("meta.snapshotHealth is missing", logContext);
    return;
  }
  if (!Number.isFinite(snapshotAgeMs) || snapshotAgeMs < 0) {
    fail("meta.snapshotAgeMs is missing or invalid", logContext);
    return;
  }
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    fail("meta.staleAfterMs is missing or invalid", logContext);
    return;
  }
  if (snapshotHealth === "stale" || snapshotAgeMs > staleAfterMs) {
    fail("production snapshot is stale", logContext);
    return;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        url: scannerUrl,
        ...logContext
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
