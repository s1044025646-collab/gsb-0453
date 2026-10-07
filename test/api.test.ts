import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createServer, BATCH_LIMIT } from "../src/server";
import { closeDb, DATA_DIR } from "../src/db";
import { AddressInfo } from "node:net";

let server: ReturnType<typeof createServer>;
let base: string;

before(async () => {
  // 测试前清空数据库，保证幂等性断言可重复
  closeDb();
  const dbFile = path.join(DATA_DIR, "wind-triangle.db");
  if (fs.existsSync(dbFile)) fs.rmSync(dbFile);
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  closeDb();
});

async function post(p: string, body: unknown): Promise<{ status: number; json: never }> {
  const res = await fetch(base + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as never };
}

test("正算 API 并持久化；重复请求返回原报告", async () => {
  const input = { tas: 100, trueHeading: 0, windSpeed: 60, windFrom: 90 };
  const r1 = await post("/api/forward", input);
  assert.equal(r1.status, 200);
  const rep1 = r1.json as { id: number; replayed: boolean; result: { groundVector: { east: number } } };
  assert.equal(rep1.replayed, false);
  assert.ok(Math.abs(rep1.result.groundVector.east + 60) < 1e-9);

  const r2 = await post("/api/forward", input);
  const rep2 = r2.json as { id: number; replayed: boolean };
  assert.equal(rep2.id, rep1.id);
  assert.equal(rep2.replayed, true);
});

test("反算 API 两解", async () => {
  const r = await post("/api/inverse", { tas: 100, desiredTrack: 0, windSpeed: 150, windFrom: 180 });
  const rep = r.json as { result: { status: string; candidates: unknown[] } };
  assert.equal(rep.result.status, "two-solutions");
  assert.equal(rep.result.candidates.length, 2);
});

test("非法输入返回错误码", async () => {
  const r = await post("/api/forward", { tas: -1, trueHeading: 0, windSpeed: 0, windFrom: 0 });
  assert.equal(r.status, 400);
  assert.equal((r.json as { error: { code: string } }).error.code, "NON_POSITIVE_TAS");
});

test("批量：失败项独立报告，不影响其他工况；超限被拒绝", async () => {
  const cases = [
    { mode: "forward", input: { tas: 100, trueHeading: 0, windSpeed: 0, windFrom: 0 } },
    { mode: "inverse", input: { tas: 100, desiredTrack: 0, windSpeed: 150, windFrom: 90 } },
    { mode: "forward", input: { tas: "bad", trueHeading: 0, windSpeed: 0, windFrom: 0 } },
  ];
  const r = await post("/api/batch", { cases });
  assert.equal(r.status, 200);
  const body = r.json as { succeeded: number; failed: number; items: Array<{ ok: boolean }> };
  assert.equal(body.succeeded, 2);
  assert.equal(body.failed, 1);
  assert.equal(body.items[2].ok, false);

  const tooMany = { cases: Array(BATCH_LIMIT + 1).fill(cases[0]) };
  const r2 = await post("/api/batch", tooMany);
  assert.equal(r2.status, 400);
  assert.equal((r2.json as { error: { code: string } }).error.code, "BATCH_TOO_LARGE");
});

test("报告查询与导出 JSON/CSV", async () => {
  const list = await (await fetch(base + "/api/reports")).json() as { reports: Array<{ id: number }> };
  assert.ok(list.reports.length >= 1);
  const id = list.reports[0].id;
  const one = await (await fetch(base + `/api/reports/${id}`)).json() as { id: number };
  assert.equal(one.id, id);
  const csv = await (await fetch(base + `/api/reports/${id}/export?format=csv`)).text();
  assert.ok(csv.includes("report_id"));
  const json = await (await fetch(base + `/api/reports/${id}/export?format=json`)).json() as { id: number };
  assert.equal(json.id, id);
  const bad = await fetch(base + `/api/reports/${id}/export?format=xml`);
  assert.equal(bad.status, 400);
  const missing = await fetch(base + "/api/reports/999999");
  assert.equal(missing.status, 404);
});

test("重启后结果一致（幂等，旧报告不重写）", async () => {
  const input = { tas: 100, desiredTrack: 0, windSpeed: 60, windFrom: 90 };
  const r1 = await post("/api/inverse", input);
  const id1 = (r1.json as { id: number }).id;

  // 模拟重启：关闭并重建连接与服务
  server.close();
  closeDb();
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  const r2 = await post("/api/inverse", input);
  const rep2 = r2.json as { id: number; replayed: boolean };
  assert.equal(rep2.id, id1);
  assert.equal(rep2.replayed, true);
});

test("解释接口", async () => {
  const text = await (await fetch(base + "/api/explain")).text();
  assert.ok(text.includes("ground = air + wind"));
});
