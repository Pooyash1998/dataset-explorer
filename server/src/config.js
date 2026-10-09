import path from "node:path";

const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
const GB = 1024 ** 3;

export const config = {
  port: num("PORT", 8787),
  dataDir: path.resolve(process.env.DATA_DIR || "./cache"),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean),
  maxDatasetBytes: num("MAX_DATASET_GB", 10) * GB,
  cacheMaxBytes: num("CACHE_MAX_GB", 20) * GB,
  indexMaxRows: num("INDEX_MAX_ROWS", 2_000_000),
  privateTtlMs: num("PRIVATE_TTL_HOURS", 12) * 3600_000,
  publicIdleMs: num("PUBLIC_IDLE_HOURS", 24) * 3600_000,
  duckMemory: process.env.DUCKDB_MEMORY || "1GB",
  duckThreads: String(num("DUCKDB_THREADS", 2)),
  maxJobs: num("MAX_JOBS", 2),
  maxOpenDbs: num("MAX_OPEN_DBS", 2),
  chunkRows: num("INDEX_CHUNK_ROWS", 1000),
};
