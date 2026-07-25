import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { providerSnapshotSchema, type ProviderId, type ProviderSnapshot } from "../types.js";

interface SnapshotRow {
  collected_at: string;
  payload_json: string;
}

export class HistoryStore {
  private readonly db: Database.Database;
  private readonly heartbeatMs = 5 * 60 * 1000;

  constructor(
    path: string,
    private readonly retentionDays = 90,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_provider_time
        ON snapshots(provider_id, collected_at DESC);
    `);
  }

  record(snapshot: ProviderSnapshot): boolean {
    const sanitized = providerSnapshotSchema.parse(snapshot);
    const fingerprint = this.fingerprint(sanitized);
    const previous = this.db
      .prepare(
        `SELECT collected_at, fingerprint
         FROM snapshots WHERE provider_id = ? ORDER BY collected_at DESC LIMIT 1`,
      )
      .get(snapshot.providerId) as { collected_at: string; fingerprint: string } | undefined;

    const heartbeatDue =
      !previous ||
      Date.parse(snapshot.collectedAt) - Date.parse(previous.collected_at) >= this.heartbeatMs;
    if (previous?.fingerprint === fingerprint && !heartbeatDue) {
      return false;
    }

    this.db
      .prepare(
        `INSERT INTO snapshots(provider_id, collected_at, fingerprint, payload_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        snapshot.providerId,
        snapshot.collectedAt,
        fingerprint,
        JSON.stringify(sanitized),
      );
    return true;
  }

  recent(providerId: ProviderId, since: Date): ProviderSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT collected_at, payload_json
         FROM snapshots
         WHERE provider_id = ? AND collected_at >= ?
         ORDER BY collected_at ASC`,
      )
      .all(providerId, since.toISOString()) as SnapshotRow[];

    return rows.flatMap((row) => {
      try {
        return [providerSnapshotSchema.parse(JSON.parse(row.payload_json))];
      } catch {
        return [];
      }
    });
  }

  latest(providerId: ProviderId): ProviderSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT collected_at, payload_json
         FROM snapshots WHERE provider_id = ? ORDER BY collected_at DESC LIMIT 1`,
      )
      .get(providerId) as SnapshotRow | undefined;
    if (!row) return undefined;
    try {
      return providerSnapshotSchema.parse(JSON.parse(row.payload_json));
    } catch {
      return undefined;
    }
  }

  prune(now = new Date()): number {
    const cutoff = new Date(now.getTime() - this.retentionDays * 86_400_000).toISOString();
    return this.db.prepare("DELETE FROM snapshots WHERE collected_at < ?").run(cutoff).changes;
  }

  close(): void {
    this.db.close();
  }

  private fingerprint(snapshot: ProviderSnapshot): string {
    const stable = {
      providerId: snapshot.providerId,
      status: snapshot.status,
      plan: snapshot.plan ?? null,
      summary: snapshot.summary,
      windows: snapshot.windows,
      metrics: snapshot.metrics,
      message: snapshot.message ?? null,
      version: snapshot.version ?? null,
    };
    return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
  }
}
