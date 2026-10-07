import { test } from "node:test";
import assert from "node:assert/strict";
import {
  forward,
  inverse,
  normalize360,
  normalize180,
  windVector,
  magnitude,
  vecFromPolar,
  InputError,
} from "../src/core";

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

test("风向约定：北风指向南，东风指向西", () => {
  const north = windVector(10, 0);
  assert.ok(close(north.east, 0) && close(north.north, -10));
  const east = windVector(60, 90);
  assert.ok(close(east.east, -60) && close(east.north, 0));
});

test("演示1 正向：tas=100 向北，东风60 → 地速向量(-60, 100)", () => {
  const r = forward({ tas: 100, trueHeading: 0, windSpeed: 60, windFrom: 90 });
  assert.equal(r.status, "ok");
  assert.ok(close(r.groundVector.east, -60));
  assert.ok(close(r.groundVector.north, 100));
  assert.ok(close(r.groundSpeed, Math.hypot(60, 100)));
});

test("演示1 反算：目标航迹正北 → 航向≈36.86989765°，地速80", () => {
  const r = inverse({ tas: 100, desiredTrack: 0, windSpeed: 60, windFrom: 90 });
  assert.equal(r.status, "one-solution");
  const c = r.candidates[0];
  assert.ok(close(c.trueHeading, 36.86989765, 1e-6));
  assert.ok(close(c.groundSpeed, 80, 1e-9));
  assert.ok(close(c.crossTrackResidual, 0, 1e-9));
  assert.ok(close(c.alongTrackProjection, 80, 1e-9));
  assert.ok(c.correctionAngle > 0); // 向右修正，不取绝对值
});

test("演示2 反算：顺风150 空速100 目标正北 → 两解 250 与 50", () => {
  const r = inverse({ tas: 100, desiredTrack: 0, windSpeed: 150, windFrom: 180 });
  assert.equal(r.status, "two-solutions");
  assert.equal(r.candidates.length, 2);
  assert.ok(close(r.candidates[0].groundSpeed, 250, 1e-9));
  assert.ok(close(r.candidates[1].groundSpeed, 50, 1e-9));
  assert.ok(close(r.candidates[1].trueHeading, 180, 1e-6)); // 朝南飞仍被风吹向北
  for (const c of r.candidates) {
    assert.ok(close(c.crossTrackResidual, 0, 1e-9));
    assert.ok(close(c.alongTrackProjection, c.groundSpeed, 1e-9));
  }
});

test("静风：航向=航迹，地速=空速", () => {
  const f = forward({ tas: 120, trueHeading: 45, windSpeed: 0, windFrom: 200 });
  assert.ok(close(f.groundSpeed, 120));
  assert.ok(close(f.groundTrack!, 45));
  const i = inverse({ tas: 120, desiredTrack: 45, windSpeed: 0, windFrom: 200 });
  assert.equal(i.status, "one-solution");
  assert.ok(close(i.candidates[0].trueHeading, 45, 1e-9));
});

test("恰好侧风（|w_cross|=tas 纯侧风）：沿航迹地速为0 → 无解", () => {
  const r = inverse({ tas: 100, desiredTrack: 0, windSpeed: 100, windFrom: 90 });
  assert.equal(r.status, "no-solution");
  assert.equal(r.candidates.length, 0);
});

test("根号为零且顺风分量>0：两分支重合只保留一个候选", () => {
  // 风从150°来、风速200：沿航迹(北)顺风分量≈173.205，侧风分量=-100=tas → s=0
  const r = inverse({ tas: 100, desiredTrack: 0, windSpeed: 200, windFrom: 150 });
  assert.equal(r.status, "one-solution");
  assert.equal(r.candidates.length, 1);
  assert.ok(close(r.candidates[0].groundSpeed, 200 * Math.cos(Math.PI / 6), 1e-4));
  assert.ok(close(r.candidates[0].crossTrackResidual, 0, 1e-6));
});

test("不可达侧风：|w_cross|>tas → 无解，不被宽泛裁剪", () => {
  const r = inverse({ tas: 100, desiredTrack: 0, windSpeed: 150, windFrom: 90 });
  assert.equal(r.status, "no-solution");
  assert.equal(r.candidates.length, 0);
});

test("过强逆风：沿航迹无法前进 → 无解", () => {
  const r = inverse({ tas: 100, desiredTrack: 0, windSpeed: 200, windFrom: 0 });
  assert.equal(r.status, "no-solution");
});

test("角度回绕：任意有限角度规范化", () => {
  assert.equal(normalize360(-90), 270);
  assert.equal(normalize360(720 + 30), 30);
  assert.equal(normalize180(270), -90);
  assert.equal(normalize180(-270), 90);
  const f = forward({ tas: 100, trueHeading: -90, windSpeed: 10, windFrom: 720 + 180 });
  assert.equal(f.input.trueHeading, 270);
  assert.equal(f.input.windFrom, 180);
});

test("零地速：航迹未定义，不假造正北，不返回时间", () => {
  const r = forward({ tas: 100, trueHeading: 0, windSpeed: 100, windFrom: 0, distance: 50 });
  assert.equal(r.status, "stationary");
  assert.equal(r.groundTrack, null);
  assert.ok(close(r.groundSpeed, 0, 1e-9));
  assert.equal(r.legTimeHours, null);
});

test("航段时间：正距离 / 正地速", () => {
  const r = forward({ tas: 100, trueHeading: 0, windSpeed: 0, windFrom: 0, distance: 200 });
  assert.ok(close(r.legTimeHours!, 2));
  const i = inverse({ tas: 100, desiredTrack: 0, windSpeed: 60, windFrom: 90, distance: 160 });
  assert.ok(close(i.candidates[0].legTimeHours!, 2));
});

test("整体旋转不变性：所有角度同加旋转量，速度大小不变", () => {
  const rot = 137;
  const base = forward({ tas: 100, trueHeading: 20, windSpeed: 40, windFrom: 250 });
  const rotated = forward({ tas: 100, trueHeading: 20 + rot, windSpeed: 40, windFrom: 250 + rot });
  assert.ok(close(base.groundSpeed, rotated.groundSpeed, 1e-9));
  assert.ok(close(normalize360(base.groundTrack! + rot), rotated.groundTrack!, 1e-9));
});

test("反算回代：候选地速方向与目标航迹一致", () => {
  for (const track of [0, 45, 123, 200, 359]) {
    const r = inverse({ tas: 130, desiredTrack: track, windSpeed: 50, windFrom: 300 });
    assert.notEqual(r.status, "no-solution");
    const u = vecFromPolar(1, track);
    for (const c of r.candidates) {
      const along = c.groundVector.east * u.east + c.groundVector.north * u.north;
      assert.ok(along > 0);
      assert.ok(close(c.crossTrackResidual, 0, 1e-6));
      assert.ok(close(magnitude(c.airVector), 130, 1e-6)); // 空速模=tas
    }
  }
});

test("输入校验：NaN/无穷/负速度被拒绝", () => {
  assert.throws(() => forward({ tas: NaN, trueHeading: 0, windSpeed: 0, windFrom: 0 }), InputError);
  assert.throws(() => forward({ tas: Infinity, trueHeading: 0, windSpeed: 0, windFrom: 0 }), InputError);
  assert.throws(() => forward({ tas: 0, trueHeading: 0, windSpeed: 0, windFrom: 0 }), InputError);
  assert.throws(() => forward({ tas: -5, trueHeading: 0, windSpeed: 0, windFrom: 0 }), InputError);
  assert.throws(() => forward({ tas: 100, trueHeading: 0, windSpeed: -1, windFrom: 0 }), InputError);
  assert.throws(() => inverse({ tas: 100, desiredTrack: 0, windSpeed: 10, windFrom: 0, distance: -3 }), InputError);
});

test("结果溢出被拒绝", () => {
  assert.throws(
    () => forward({ tas: 1e308, trueHeading: 0, windSpeed: 1e308, windFrom: 180 }),
    (e: Error) => e instanceof InputError && (e as InputError).code === "RESULT_OVERFLOW"
  );
});

test("修正角保留符号：西风（吹向东）需向左修正，修正角为负", () => {
  const r = inverse({ tas: 100, desiredTrack: 0, windSpeed: 60, windFrom: 270 });
  assert.ok(r.candidates[0].correctionAngle < 0);
  assert.ok(r.candidates[0].correctionAngle >= -180 && r.candidates[0].correctionAngle < 180);
});
