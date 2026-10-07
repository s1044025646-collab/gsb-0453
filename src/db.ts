// SQLite 持久化层（Node 内置 node:sqlite，无原生依赖）。
// 保存原输入、规范化角度、单位、容差版本与全部候选；
// 报告只新增、不改写：切换风向或参数会生成新报告，重复请求返回原结果。

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "wind-triangle.db");

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_hash TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      units TEXT NOT NULL,
      tolerance_version TEXT NOT NULL,
      raw_input TEXT NOT NULL,
      normalized_input TEXT NOT NULL,
      result TEXT NOT NULL
    );
  `);
  return db;
}

/** 关闭并重置连接（测试用） */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

export function requestHash(mode: string, payload: unknown): string {
  return createHash("sha256").update(mode + ":" + canonicalize(payload)).digest("hex");
}

export interface StoredReport {
  id: number;
  requestHash: string;
  mode: string;
  createdAt: string;
  units: unknown;
  toleranceVersion: string;
  rawInput: unknown;
  normalizedInput: unknown;
  result: unknown;
  replayed: boolean;
}

interface Row {
  id: number;
  request_hash: string;
  mode: string;
  created_at: string;
  units: string;
  tolerance_version: string;
  raw_input: string;
  normalized_input: string;
  result: string;
}

function rowToReport(row: Row, replayed: boolean): StoredReport {
  return {
    id: row.id,
    requestHash: row.request_hash,
    mode: row.mode,
    createdAt: row.created_at,
    units: JSON.parse(row.units),
    toleranceVersion: row.tolerance_version,
    rawInput: JSON.parse(row.raw_input),
    normalizedInput: JSON.parse(row.normalized_input),
    result: JSON.parse(row.result),
    replayed,
  };
}

/** 保存报告；若相同请求已存在，返回原报告（replayed=true），不重写旧结论。 */
export function saveReport(
  mode: string,
  rawInput: unknown,
  normalizedInput: unknown,
  units: unknown,
  toleranceVersion: string,
  result: unknown
): StoredReport {
  const d = getDb();
  const hash = requestHash(mode, rawInput);
  const existing = d.prepare("SELECT * FROM reports WHERE request_hash = ?").get(hash) as unknown as Row | undefined;
  if (existing) return rowToReport(existing, true);

  const createdAt = new Date().toISOString();
  const stmt = d.prepare(
    `INSERT INTO reports (request_hash, mode, created_at, units, tolerance_version, raw_input, normalized_input, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    hash,
    mode,
    createdAt,
    JSON.stringify(units),
    toleranceVersion,
    JSON.stringify(rawInput),
    JSON.stringify(normalizedInput),
    JSON.stringify(result)
  );
  const row = d.prepare("SELECT * FROM reports WHERE id = ?").get(Number(info.lastInsertRowid)) as unknown as Row;
  return rowToReport(row, false);
}

export function getReport(id: number): StoredReport | null {
  const row = getDb().prepare("SELECT * FROM reports WHERE id = ?").get(id) as unknown as Row | undefined;
  return row ? rowToReport(row, false) : null;
}

export function listReports(limit = 100): StoredReport[] {
  const rows = getDb()
    .prepare("SELECT * FROM reports ORDER BY id DESC LIMIT ?")
    .all(limit) as unknown as Row[];
  return rows.map((r) => rowToReport(r, false));
}
