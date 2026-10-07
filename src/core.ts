/**
 * 平面风三角核心计算。
 * 单位约定：速度 kt（节），距离 nm（海里），时间 h（小时）。
 * 方向约定：自正北顺时针的度数；风向为“风从哪里来”。
 * 分量约定：方向 a、速度 v -> (east = v*sin(a), north = v*cos(a))。
 */

export const SPEED_UNIT = "kt";
export const DISTANCE_UNIT = "nm";
export const TIME_UNIT = "h";

export const TOLERANCE_VERSION = "tol-v1";
export const ABS_TOL = 1e-9;
export const REL_TOL = 1e-9;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export interface Vec2 {
  east: number;
  north: number;
}

export class ValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function assertFinite(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError("E_NOT_FINITE", `${name} 必须是有限数值`);
  }
}

/** 规范化到 [0, 360)。 */
export function norm360(deg: number): number {
  const r = ((deg % 360) + 360) % 360;
  return r >= 360 ? 0 : r;
}

/** 规范化到 [-180, 180)，保留左右符号。 */
export function norm180(deg: number): number {
  const r = norm360(deg + 180) - 180;
  return r;
}

/** 速度 v、方向 a（自北顺时针）-> 东/北分量。 */
export function components(v: number, deg: number): Vec2 {
  const a = deg * DEG2RAD;
  return { east: v * Math.sin(a), north: v * Math.cos(a) };
}

/** 风“从” from 度吹来 -> 风向量（指向其反方向，如北风指向南）。 */
export function windVector(windSpeed: number, windFrom: number): Vec2 {
  const c = components(windSpeed, windFrom);
  return { east: -c.east, north: -c.north };
}

function magnitude(v: Vec2): number {
  return Math.hypot(v.east, v.north);
}

function directionOf(v: Vec2): number {
  return norm360(Math.atan2(v.east, v.north) * RAD2DEG);
}

function add(a: Vec2, b: Vec2): Vec2 {
  return { east: a.east + b.east, north: a.north + b.north };
}

function dot(a: Vec2, b: Vec2): number {
  return a.east * b.east + a.north * b.north;
}

function scale(v: Vec2, s: number): Vec2 {
  return { east: v.east * s, north: v.north * s };
}

function checkOverflow(v: Vec2): void {
  if (!Number.isFinite(v.east) || !Number.isFinite(v.north)) {
    throw new ValidationError("E_OVERFLOW", "计算结果溢出（非有限值）");
  }
}

export interface ForwardInput {
  tas: number;
  heading: number;
  windSpeed: number;
  windFrom: number;
  distance?: number;
}

export interface ForwardResult {
  kind: "moving" | "stationary";
  unit: { speed: string; distance: string; time: string };
  input: { tas: number; heading: number; windSpeed: number; windFrom: number; distance: number | null };
  airVector: Vec2;
  windVector: Vec2;
  groundVector: Vec2;
  groundSpeed: number;
  /** 地速接近零时为 null（方向未定义），绝不伪造正北。 */
  track: number | null;
  /** 仅当给定正距离且地速为正时存在。 */
  legTime: number | null;
}

function validateCommon(tas: unknown, windSpeed: unknown, windFrom: unknown, distance: unknown): void {
  assertFinite("tas", tas);
  assertFinite("windSpeed", windSpeed);
  assertFinite("windFrom", windFrom);
  if (tas <= 0) throw new ValidationError("E_TAS_NOT_POSITIVE", "真空速必须为正");
  if (windSpeed < 0) throw new ValidationError("E_WIND_NEGATIVE", "风速不能为负");
  if (distance !== undefined && distance !== null) {
    assertFinite("distance", distance);
    if (distance <= 0) throw new ValidationError("E_DISTANCE_NOT_POSITIVE", "距离必须为正");
  }
}

export function forward(input: ForwardInput): ForwardResult {
  const { tas, heading, windSpeed, windFrom, distance } = input;
  validateCommon(tas, windSpeed, windFrom, distance);
  assertFinite("heading", heading);

  const hdg = norm360(heading);
  const wFrom = norm360(windFrom);
  const air = components(tas, hdg);
  const wind = windVector(windSpeed, wFrom);
  const ground = add(air, wind);
  checkOverflow(ground);
  const gs = magnitude(ground);
  const stationary = gs <= ABS_TOL + REL_TOL * tas;
  const track = stationary ? null : directionOf(ground);
  const legTime = distance != null && !stationary && gs > 0 ? distance / gs : null;

  return {
    kind: stationary ? "stationary" : "moving",
    unit: { speed: SPEED_UNIT, distance: DISTANCE_UNIT, time: TIME_UNIT },
    input: { tas, heading: hdg, windSpeed, windFrom: wFrom, distance: distance ?? null },
    airVector: air,
    windVector: wind,
    groundVector: ground,
    groundSpeed: gs,
    track,
    legTime,
  };
}

export interface InverseInput {
  tas: number;
  track: number;
  windSpeed: number;
  windFrom: number;
  distance?: number;
}

export interface InverseCandidate {
  /** 沿航迹空速分支：plus = +sqrt(tas²-w_cross²)，minus = -sqrt(...)。 */
  branch: "plus" | "minus";
  heading: number;
  /** 航向修正角，归一化到 [-180,180)，保留左右符号。 */
  correction: number;
  groundSpeed: number;
  airVector: Vec2;
  groundVector: Vec2;
  /** 回代核验：真实地速向量在目标右侧的残差（应≈0）与沿目标方向投影（应=地速）。 */
  verification: { crossResidual: number; alongProjection: number };
  legTime: number | null;
}

export interface InverseResult {
  kind: "no_solution" | "unique" | "two_solutions";
  unit: { speed: string; distance: string; time: string };
  input: { tas: number; track: number; windSpeed: number; windFrom: number; distance: number | null };
  windDecomposition: { wParallel: number; wCross: number };
  candidates: InverseCandidate[];
}

export function inverse(input: InverseInput): InverseResult {
  const { tas, track, windSpeed, windFrom, distance } = input;
  validateCommon(tas, windSpeed, windFrom, distance);
  assertFinite("track", track);

  const trk = norm360(track);
  const wFrom = norm360(windFrom);
  const u = components(1, trk); // 目标航迹单位向量
  const r = { east: u.north, north: -u.east }; // 右侧单位向量（航迹+90°）
  const wind = windVector(windSpeed, wFrom);

  const wParallel = dot(wind, u);
  let wCross = dot(wind, r);

  const base: InverseResult = {
    kind: "no_solution",
    unit: { speed: SPEED_UNIT, distance: DISTANCE_UNIT, time: TIME_UNIT },
    input: { tas, track: trk, windSpeed, windFrom: wFrom, distance: distance ?? null },
    windDecomposition: { wParallel, wCross },
    candidates: [],
  };

  // 侧风明显超过真空速 -> 无解；仅在容差范围内才夹取。
  const crossLimit = tas + (ABS_TOL + REL_TOL * tas);
  if (Math.abs(wCross) > crossLimit) {
    return base;
  }
  if (Math.abs(wCross) > tas) wCross = Math.sign(wCross) * tas;

  // 只有因浮点微差略小于零的根号项才归零。
  let radicand = tas * tas - wCross * wCross;
  if (radicand < 0) {
    if (radicand >= -(ABS_TOL + REL_TOL * tas * tas)) radicand = 0;
    else return base;
  }
  const s = Math.sqrt(radicand);

  const branches: Array<"plus" | "minus"> = s <= ABS_TOL + REL_TOL * tas ? ["plus"] : ["plus", "minus"];
  const candidates: InverseCandidate[] = [];

  for (const branch of branches) {
    const along = branch === "plus" ? s : -s;
    const gs = wParallel + along;
    // 只有严格为正的地速才能沿目标方向前进。
    if (!(gs > ABS_TOL + REL_TOL * tas)) continue;
    const air = add(scale(u, along), scale(r, -wCross));
    const ground = add(air, wind);
    checkOverflow(ground);
    const heading = directionOf(air);
    candidates.push({
      branch,
      heading,
      correction: norm180(heading - trk),
      groundSpeed: gs,
      airVector: air,
      groundVector: ground,
      verification: { crossResidual: dot(ground, r), alongProjection: dot(ground, u) },
      legTime: distance != null ? distance / gs : null,
    });
  }

  candidates.sort((a, b) => b.groundSpeed - a.groundSpeed);
  base.candidates = candidates;
  base.kind = candidates.length === 0 ? "no_solution" : candidates.length === 1 ? "unique" : "two_solutions";
  return base;
}
