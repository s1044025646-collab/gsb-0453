import { forward, inverse, ForwardInput, InverseInput, ValidationError } from "./core.js";
import { ReportStore, StoredReport } from "./store.js";

export const BATCH_LIMIT = 100;

export interface ApiOk {
  ok: true;
  reportId: number;
  reused: boolean;
  result: unknown;
}

export interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}

export type ApiResponse = ApiOk | ApiErr;

function toErr(e: unknown): ApiErr {
  if (e instanceof ValidationError) return { ok: false, error: { code: e.code, message: e.message } };
  if (e instanceof Error) return { ok: false, error: { code: "E_INTERNAL", message: e.message } };
  return { ok: false, error: { code: "E_INTERNAL", message: String(e) } };
}

export class WindService {
  constructor(public store: ReportStore) {}

  runForward(input: ForwardInput): ApiResponse {
    try {
      const result = forward(input);
      const saved = this.store.saveReport("forward", input, result, result.unit.speed);
      return { ok: true, reportId: saved.report.id, reused: saved.reused, result };
    } catch (e) {
      return toErr(e);
    }
  }

  runInverse(input: InverseInput): ApiResponse {
    try {
      const result = inverse(input);
      const saved = this.store.saveReport("inverse", input, result, result.unit.speed);
      return { ok: true, reportId: saved.report.id, reused: saved.reused, result };
    } catch (e) {
      return toErr(e);
    }
  }

  runBatch(cases: unknown[]): { ok: true; results: Array<{ index: number } & ApiResponse> } | ApiErr {
    if (!Array.isArray(cases)) {
      return { ok: false, error: { code: "E_BATCH_NOT_ARRAY", message: "cases 必须是数组" } };
    }
    if (cases.length > BATCH_LIMIT) {
      return { ok: false, error: { code: "E_BATCH_TOO_LARGE", message: `批量上限为 ${BATCH_LIMIT} 项` } };
    }
    const results = cases.map((c, index) => {
      const item = c as { mode?: string } & Record<string, unknown>;
      if (item && item.mode === "forward") return { index, ...this.runForward(item as unknown as ForwardInput) };
      if (item && item.mode === "inverse") return { index, ...this.runInverse(item as unknown as InverseInput) };
      return {
        index,
        ok: false as const,
        error: { code: "E_MODE_UNKNOWN", message: "mode 必须是 forward 或 inverse" },
      };
    });
    return { ok: true, results };
  }

  getReport(id: number): (ApiOk & { report: StoredReport }) | ApiErr {
    const report = this.store.getById(id);
    if (!report) return { ok: false, error: { code: "E_NOT_FOUND", message: `报告 ${id} 不存在` } };
    return { ok: true, reportId: id, reused: true, result: JSON.parse(report.resultJson), report };
  }

  explain(id: number): ApiResponse {
    const got = this.getReport(id);
    if (!got.ok) return got;
    const result = got.result as Record<string, unknown>;
    return {
      ok: true,
      reportId: id,
      reused: true,
      result: {
        mode: got.report.mode,
        toleranceVersion: got.report.toleranceVersion,
        unit: result.unit,
        explanation: {
          convention:
            "方向自正北顺时针；分量 (east=v*sin(a), north=v*cos(a))；风向为来向，风向量取反（北风指向南）；ground = air + wind。",
          airVector: result.airVector ?? null,
          windVector: result.windVector ?? null,
          groundVector: result.groundVector ?? null,
          windDecomposition: result.windDecomposition ?? null,
          candidates: result.candidates ?? null,
        },
      },
    };
  }

  exportReport(id: number, format: "json" | "csv"): { ok: true; content: string; contentType: string } | ApiErr {
    const got = this.getReport(id);
    if (!got.ok) return got;
    const result = JSON.parse(got.report.resultJson) as Record<string, unknown>;
    if (format === "json") {
      return { ok: true, content: JSON.stringify(result, null, 2), contentType: "application/json" };
    }
    const rows: string[] = ["section,key,value"];
    const push = (section: string, key: string, value: unknown) =>
      rows.push(`${section},${key},${value === null || value === undefined ? "" : String(value)}`);
    push("meta", "mode", got.report.mode);
    push("meta", "toleranceVersion", got.report.toleranceVersion);
    const inp = (result.input ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(inp)) push("input", k, v);
    if (got.report.mode === "forward") {
      push("forward", "kind", result.kind);
      push("forward", "groundSpeed", result.groundSpeed);
      push("forward", "track", result.track);
      push("forward", "legTime", result.legTime);
      const gv = result.groundVector as { east: number; north: number };
      push("forward", "groundEast", gv.east);
      push("forward", "groundNorth", gv.north);
    } else {
      push("inverse", "kind", result.kind);
      const cands = (result.candidates ?? []) as Array<Record<string, unknown>>;
      cands.forEach((c, i) => {
        push(`candidate${i}`, "branch", c.branch);
        push(`candidate${i}`, "heading", c.heading);
        push(`candidate${i}`, "correction", c.correction);
        push(`candidate${i}`, "groundSpeed", c.groundSpeed);
        push(`candidate${i}`, "legTime", c.legTime);
      });
    }
    return { ok: true, content: rows.join("\n") + "\n", contentType: "text/csv" };
  }
}
