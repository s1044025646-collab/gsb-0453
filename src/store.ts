import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { TOLERANCE_VERSION } from "./core.js";

export interface StoredReport {
  id: number;
  requestHash: string;
  mode: string;
  inputJson: string;
  resultJson: string;
  unit: string;
  toleranceVersion: string;
  createdAt: string;
}

export class ReportStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_hash TEXT NOT NULL,
        mode TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        unit TEXT NOT NULL,
        tolerance_version TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_hash ON reports(request_hash);
    `);
  }

  static hashRequest(mode: string, payload: unknown): string {
    const canonical = JSON.stringify({ mode, payload, toleranceVersion: TOLERANCE_VERSION });
    return createHash("sha256").update(canonical).digest("hex");
  }

  /** 幂等保存：相同请求返回已有报告，不生成新行。 */
  saveReport(mode: string, input: unknown, result: unknown, unit: string): { report: StoredReport; reused: boolean } {
    const hash = ReportStore.hashRequest(mode, input);
    const existing = this.db.prepare("SELECT * FROM reports WHERE request_hash = ?").get(hash) as unknown as
      | StoredReportRow
      | undefined;
    if (existing) return { report: rowToReport(existing), reused: true };
    const info = this.db
      .prepare(
        "INSERT INTO reports (request_hash, mode, input_json, result_json, unit, tolerance_version) VALUES (?,?,?,?,?,?)"
      )
      .run(hash, mode, JSON.stringify(input), JSON.stringify(result), unit, TOLERANCE_VERSION);
    return { report: this.getById(Number(info.lastInsertRowid))!, reused: false };
  }

  getById(id: number): StoredReport | null {
    const row = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as unknown as StoredReportRow | undefined;
    return row ? rowToReport(row) : null;
  }

  list(limit = 50): StoredReport[] {
    const rows = this.db.prepare("SELECT * FROM reports ORDER BY id DESC LIMIT ?").all(limit) as unknown as StoredReportRow[];
    return rows.map(rowToReport);
  }

  close(): void {
    this.db.close();
  }
}

interface StoredReportRow {
  id: number;
  request_hash: string;
  mode: string;
  input_json: string;
  result_json: string;
  unit: string;
  tolerance_version: string;
  created_at: string;
}

function rowToReport(row: StoredReportRow): StoredReport {
  return {
    id: row.id,
    requestHash: row.request_hash,
    mode: row.mode,
    inputJson: row.input_json,
    resultJson: row.result_json,
    unit: row.unit,
    toleranceVersion: row.tolerance_version,
    createdAt: row.created_at,
  };
}
