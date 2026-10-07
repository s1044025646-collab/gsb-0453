import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { forward, inverse, norm180, norm360, ValidationError } from "../src/core.js";
import { ReportStore } from "../src/store.js";
import { WindService, BATCH_LIMIT } from "../src/service.js";

const close = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test("演示1: TAS=100 向北，东风60 -> 地速向量(-60, 100)", () => {
  const r = forward({ tas: 100, heading: 0, windSpeed: 60, windFrom: 90 });
  close(r.groundVector.east, -60);
  close(r.groundVector.north, 100);
  assert.equal(r.kind, "moving");
});

test("演示2: 目标航迹正北，东风60 -> 航向≈36.86989765，地速80", () => {
  const r = inverse({ tas: 100, track: 0, windSpeed: 60, windFrom: 90 });
  assert.equal(r.kind, "unique");
  const c = r.candidates[0];
  close(c.heading, 36.86989765, 1e-6); // 风自东吹向西，需向东压航向补偿
  close(c.groundSpeed, 80);
  close(c.correction, 36.86989765, 1e-6);
  assert.ok(c.correction > 0, "修正角应保留符号（向右为正）");
});

test("演示3: 顺风150、TAS=100 目标正北 -> 两解 250 与 50", () => {
  const r = inverse({ tas: 100, track: 0, windSpeed: 150, windFrom: 180 });
  assert.equal(r.kind, "two_solutions");
  close(r.candidates[0].groundSpeed, 250);
  assert.equal(r.candidates[0].branch, "plus");
  close(r.candidates[0].heading, 0);
  close(r.candidates[1].groundSpeed, 50);
  assert.equal(r.candidates[1].branch, "minus");
  close(r.candidates[1].heading, 180); // 朝南飞也能随风向北
});

test("静风: 反算航向=航迹，地速=真空速", () => {
  const r = inverse({ tas: 120, track: 45, windSpeed: 0, windFrom: 0 });
  assert.equal(r.kind, "unique");
  close(r.candidates[0].heading, 45);
  close(r.candidates[0].groundSpeed, 120);
});

test("恰好侧风: |w_cross|=TAS 时根号归零，两分支重合去重；地速为零不前进", () => {
  // 纯正侧风且 |w_cross|=TAS：s=0，两分支重合，唯一候选地速=0，被过滤 -> 无解
  const r = inverse({ tas: 60, track: 0, windSpeed: 60, windFrom: 90 });
  assert.equal(r.kind, "no_solution");
  assert.equal(r.candidates.length, 0);
  // 带顺风分量的恰好侧风：唯一候选且地速为正
  const r2 = inverse({ tas: 60, track: 0, windSpeed: 60 * Math.SQRT2, windFrom: 135 });
  assert.equal(r2.kind, "unique");
  assert.equal(r2.candidates.length, 1);
  close(r2.candidates[0].groundSpeed, 60, 1e-9);
});

test("不可达侧风: |w_cross|>TAS -> 无解，且不被容差裁剪", () => {
  const r = inverse({ tas: 50, track: 0, windSpeed: 80, windFrom: 90 });
  assert.equal(r.kind, "no_solution");
  assert.equal(r.candidates.length, 0);
});

test("过强逆风: 顶风200、TAS=100 -> 无解（地速非正）", () => {
  const r = inverse({ tas: 100, track: 0, windSpeed: 200, windFrom: 0 });
  assert.equal(r.kind, "no_solution");
});

test("角度回绕: 航向 -90 等价 270，航迹 720 等价 0", () => {
  const a = forward({ tas: 100, heading: -90, windSpeed: 0, windFrom: 0 });
  close(a.groundVector.east, -100);
  assert.equal(a.input.heading, 270);
  const b = inverse({ tas: 100, track: 720, windSpeed: 0, windFrom: 0 });
  close(b.candidates[0].heading, 0);
  assert.equal(norm360(-10), 350);
  assert.equal(norm180(180), -180);
  assert.equal(norm180(359), -1);
});

test("零地速: 航迹方向标记为 null，不伪造正北", () => {
  const r = forward({ tas: 100, heading: 0, windSpeed: 100, windFrom: 0 }); // 顶风100抵消
  assert.equal(r.kind, "stationary");
  assert.equal(r.track, null);
  assert.equal(r.legTime, null, "静止时不返回航段时间");
});

test("整体旋转不变性: 所有角度+40°，速度大小不变", () => {
  const base = forward({ tas: 100, heading: 10, windSpeed: 40, windFrom: 200 });
  const rot = forward({ tas: 100, heading: 50, windSpeed: 40, windFrom: 240 });
  close(base.groundSpeed, rot.groundSpeed, 1e-9);
  close(norm360(base.track! + 40), rot.track!, 1e-9);
});

test("反算回代核验: 候选真实地速向量符合目标方向", () => {
  const r = inverse({ tas: 100, track: 30, windSpeed: 60, windFrom: 120 });
  for (const c of r.candidates) {
    close(c.verification.crossResidual, 0, 1e-6);
    close(c.verification.alongProjection, c.groundSpeed, 1e-6);
  }
});

test("参数校验: NaN/无穷/负速度被拒绝", () => {
  assert.throws(() => forward({ tas: NaN, heading: 0, windSpeed: 0, windFrom: 0 }), ValidationError);
  assert.throws(() => forward({ tas: Infinity, heading: 0, windSpeed: 0, windFrom: 0 }), ValidationError);
  assert.throws(() => forward({ tas: -5, heading: 0, windSpeed: 0, windFrom: 0 }), ValidationError);
  assert.throws(() => forward({ tas: 100, heading: 0, windSpeed: -1, windFrom: 0 }), ValidationError);
  assert.throws(() => inverse({ tas: 100, track: 0, windSpeed: 0, windFrom: NaN }), ValidationError);
  assert.throws(() => forward({ tas: 100, heading: 0, windSpeed: 0, windFrom: 0, distance: -3 }), ValidationError);
});

test("航段时间: 正距离按地速计算", () => {
  const r = forward({ tas: 100, heading: 0, windSpeed: 0, windFrom: 0, distance: 50 });
  close(r.legTime!, 0.5);
});

function makeService(): { svc: WindService; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "wind-test-"));
  return { svc: new WindService(new ReportStore(path.join(dir, "t.db"))), dir };
}

test("存储: 重复请求返回原报告，不生成新行", () => {
  const { svc, dir } = makeService();
  const a = svc.runForward({ tas: 100, heading: 0, windSpeed: 60, windFrom: 90 });
  const b = svc.runForward({ tas: 100, heading: 0, windSpeed: 60, windFrom: 90 });
  if (!a.ok || !b.ok) assert.fail("请求应成功");
  assert.equal(a.reportId, b.reportId);
  assert.equal(b.reused, true);
  svc.store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("存储: 重启后结果一致（报告冻结）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wind-test-"));
  const db = path.join(dir, "t.db");
  const svc1 = new WindService(new ReportStore(db));
  const a = svc1.runInverse({ tas: 100, track: 0, windSpeed: 150, windFrom: 180 });
  svc1.store.close();
  const svc2 = new WindService(new ReportStore(db));
  if (!a.ok) assert.fail("请求应成功");
  const got = svc2.getReport(a.reportId);
  if (!got.ok) assert.fail("报告应存在");
  assert.deepEqual(got.result, a.result);
  svc2.store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("批量: 失败项独立报告，不影响其他工况；超上限被拒", () => {
  const { svc, dir } = makeService();
  const out = svc.runBatch([
    { mode: "forward", tas: 100, heading: 0, windSpeed: 0, windFrom: 0 },
    { mode: "inverse", tas: -1, track: 0, windSpeed: 0, windFrom: 0 },
    { mode: "bogus" },
  ]);
  if (!out.ok) assert.fail("批量应整体成功");
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[1].ok, false);
  assert.equal((out.results[1] as { error: { code: string } }).error.code, "E_TAS_NOT_POSITIVE");
  assert.equal(out.results[2].ok, false);
  const tooMany = svc.runBatch(new Array(BATCH_LIMIT + 1).fill({ mode: "forward", tas: 1, heading: 0, windSpeed: 0, windFrom: 0 }));
  assert.equal(tooMany.ok, false);
  svc.store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("导出: JSON 与 CSV 均可用", () => {
  const { svc, dir } = makeService();
  const a = svc.runInverse({ tas: 100, track: 0, windSpeed: 150, windFrom: 180 });
  if (!a.ok) assert.fail("请求应成功");
  const json = svc.exportReport(a.reportId, "json");
  const csv = svc.exportReport(a.reportId, "csv");
  if (!json.ok || !csv.ok) assert.fail("导出应成功");
  assert.ok(csv.content.includes("candidate0"));
  svc.store.close();
  rmSync(dir, { recursive: true, force: true });
});
