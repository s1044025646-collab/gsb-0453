// HTTP API 服务（node:http，零运行时依赖）。

import * as http from "node:http";
import {
  forward,
  inverse,
  InputError,
  ForwardRequest,
  InverseRequest,
  ForwardResult,
  InverseResult,
} from "./core";
import { saveReport, getReport, listReports, StoredReport } from "./db";
import { EXPLANATION } from "./explain";

export const BATCH_LIMIT = 100;

interface ApiError {
  error: { code: string; message: string };
}

function err(code: string, message: string): ApiError {
  return { error: { code, message } };
}

function send(res: http.ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": contentType });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8").trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new InputError("BAD_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function runAndStore(mode: "forward" | "inverse", raw: unknown): StoredReport {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InputError("BAD_INPUT", "请求体必须是 JSON 对象");
  }
  const req = raw as Record<string, unknown>;
  const result = mode === "forward" ? forward(req as unknown as ForwardRequest) : inverse(req as unknown as InverseRequest);
  return saveReport(mode, raw, result.input, result.units, result.toleranceVersion, result);
}

function reportToCsv(report: StoredReport): string {
  const result = report.result as ForwardResult | InverseResult;
  const lines: string[] = [];
  lines.push(`report_id,${report.id}`);
  lines.push(`mode,${report.mode}`);
  lines.push(`created_at,${report.createdAt}`);
  lines.push(`tolerance_version,${report.toleranceVersion}`);
  lines.push(`status,${result.status}`);
  lines.push("");
  if (result.kind === "forward") {
    lines.push("component,east,north");
    lines.push(`air,${result.airVector.east},${result.airVector.north}`);
    lines.push(`wind,${result.windVector.east},${result.windVector.north}`);
    lines.push(`ground,${result.groundVector.east},${result.groundVector.north}`);
    lines.push("");
    lines.push("ground_speed,ground_track,leg_time_hours");
    lines.push(`${result.groundSpeed},${result.groundTrack ?? ""},${result.legTimeHours ?? ""}`);
  } else {
    lines.push("branch,true_heading,correction_angle,ground_speed,cross_residual,along_projection,leg_time_hours");
    for (const c of result.candidates) {
      lines.push(
        `${c.branch},${c.trueHeading},${c.correctionAngle},${c.groundSpeed},${c.crossTrackResidual},${c.alongTrackProjection},${c.legTimeHours ?? ""}`
      );
    }
  }
  return lines.join("\r\n") + "\r\n";
}

async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/api/health") {
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && pathname === "/api/explain") {
    return send(res, 200, EXPLANATION, "text/plain; charset=utf-8");
  }
  if (req.method === "POST" && pathname === "/api/forward") {
    const body = await readBody(req);
    return send(res, 200, runAndStore("forward", body));
  }
  if (req.method === "POST" && pathname === "/api/inverse") {
    const body = await readBody(req);
    return send(res, 200, runAndStore("inverse", body));
  }
  if (req.method === "POST" && pathname === "/api/batch") {
    const body = (await readBody(req)) as { cases?: Array<{ mode?: string; input?: unknown }> };
    if (!body || !Array.isArray(body.cases)) {
      throw new InputError("BAD_INPUT", "请求体需为 { cases: [{ mode, input }, ...] }");
    }
    if (body.cases.length > BATCH_LIMIT) {
      throw new InputError("BATCH_TOO_LARGE", `批量上限为 ${BATCH_LIMIT}，收到 ${body.cases.length}`);
    }
    const items = body.cases.map((c, i) => {
      try {
        const mode = c?.mode;
        if (mode !== "forward" && mode !== "inverse") {
          throw new InputError("BAD_MODE", `cases[${i}].mode 必须是 "forward" 或 "inverse"`);
        }
        return { index: i, ok: true as const, report: runAndStore(mode, c.input) };
      } catch (e) {
        const ie = e as InputError;
        return { index: i, ok: false as const, error: { code: ie.code ?? "ERROR", message: ie.message } };
      }
    });
    return send(res, 200, { items, succeeded: items.filter((x) => x.ok).length, failed: items.filter((x) => !x.ok).length });
  }
  if (req.method === "GET" && pathname === "/api/reports") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 1000);
    return send(res, 200, { reports: listReports(limit) });
  }
  const m = pathname.match(/^\/api\/reports\/(\d+)(\/export)?$/);
  if (req.method === "GET" && m) {
    const report = getReport(Number(m[1]));
    if (!report) return send(res, 404, err("NOT_FOUND", `报告 ${m[1]} 不存在`));
    if (m[2] === "/export") {
      const format = url.searchParams.get("format") ?? "json";
      if (format === "csv") return send(res, 200, reportToCsv(report), "text/csv; charset=utf-8");
      if (format === "json") return send(res, 200, report);
      return send(res, 400, err("BAD_FORMAT", "format 仅支持 json 或 csv"));
    }
    return send(res, 200, report);
  }
  send(res, 404, err("NOT_FOUND", `未知路由: ${req.method} ${pathname}`));
}

export function createServer(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    route(req, res, url).catch((e) => {
      const ie = e as InputError;
      if (ie instanceof InputError) return send(res, 400, err(ie.code, ie.message));
      send(res, 500, err("INTERNAL", String((e as Error).message ?? e)));
    });
  });
}

/** 默认端口 0 = 由系统分配空闲端口；可用 PORT 环境变量或参数指定。 */
export function startServer(port = Number(process.env.PORT ?? 0)): Promise<number> {
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      console.log(`风三角 API 服务已启动: http://localhost:${actual}`);
      resolve(actual);
    });
  });
}

if (require.main === module) {
  void startServer();
}
