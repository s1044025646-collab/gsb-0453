import http from "node:http";
import { AddressInfo } from "node:net";
import { WindService } from "./service.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf-8");
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { code: "E_BAD_JSON" });
  }
}

export function createServer(service: WindService): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/api/health") {
        return sendJson(res, 200, { ok: true, service: "wind-triangle", unit: "kt" });
      }
      if (req.method === "POST" && path === "/api/forward") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const out = service.runForward({
          tas: body.tas as number,
          heading: body.heading as number,
          windSpeed: body.windSpeed as number,
          windFrom: body.windFrom as number,
          distance: body.distance as number | undefined,
        });
        return sendJson(res, out.ok ? 200 : 400, out);
      }
      if (req.method === "POST" && path === "/api/inverse") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const out = service.runInverse({
          tas: body.tas as number,
          track: body.track as number,
          windSpeed: body.windSpeed as number,
          windFrom: body.windFrom as number,
          distance: body.distance as number | undefined,
        });
        return sendJson(res, out.ok ? 200 : 400, out);
      }
      if (req.method === "POST" && path === "/api/batch") {
        const body = (await readBody(req)) as { cases?: unknown[] };
        const out = service.runBatch(body?.cases as unknown[]);
        return sendJson(res, out.ok ? 200 : 400, out);
      }
      const reportMatch = path.match(/^\/api\/reports\/(\d+)$/);
      if (req.method === "GET" && reportMatch) {
        const out = service.getReport(Number(reportMatch[1]));
        return sendJson(res, out.ok ? 200 : 404, out);
      }
      const explainMatch = path.match(/^\/api\/reports\/(\d+)\/explain$/);
      if (req.method === "GET" && explainMatch) {
        const out = service.explain(Number(explainMatch[1]));
        return sendJson(res, out.ok ? 200 : 404, out);
      }
      const exportMatch = path.match(/^\/api\/reports\/(\d+)\/export$/);
      if (req.method === "GET" && exportMatch) {
        const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
        const out = service.exportReport(Number(exportMatch[1]), format);
        if (!out.ok) return sendJson(res, 404, out);
        res.writeHead(200, { "Content-Type": `${out.contentType}; charset=utf-8` });
        return res.end(out.content);
      }
      if (req.method === "GET" && path === "/api/reports") {
        return sendJson(res, 200, { ok: true, reports: service.store.list(50) });
      }
      sendJson(res, 404, { ok: false, error: { code: "E_ROUTE_NOT_FOUND", message: `未知路由 ${req.method} ${path}` } });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      sendJson(res, 400, {
        ok: false,
        error: { code: err.code ?? "E_INTERNAL", message: err.message ?? String(e) },
      });
    }
  });
}

export function startServer(service: WindService, port = 0): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(service);
    server.on("error", reject);
    server.listen(port, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}
