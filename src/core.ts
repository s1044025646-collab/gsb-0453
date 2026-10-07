// 平面风三角核心计算（教学用）。
//
// 坐标系：东-北局部平面。速度 v、方向 a（度，自正北顺时针）对应向量
//   (v*sin(a), v*cos(a))，即 (东分量, 北分量)。
// 风向（windFrom）表示风“从哪里来”，风向量是该方向向量的相反数：
// 北风（windFrom=0）的风向量指向南 (0, -v)。
//
// 核心关系：ground = air + wind。

export const TOLERANCE_VERSION = "tol-v1";
/** 绝对容差与相对容差（公开、冻结，随 TOLERANCE_VERSION 变更） */
export const ABS_TOL = 1e-9;
export const REL_TOL = 1e-9;

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export interface Vec2 {
  east: number;
  north: number;
}

export class InputError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function normalize360(deg: number): number {
  const r = deg % 360;
  const n = r < 0 ? r + 360 : r;
  return n === 360 ? 0 : n;
}

/** 规范化到 [-180, 180)，保留左右符号，不取绝对值。 */
export function normalize180(deg: number): number {
  const n = normalize360(deg);
  return n >= 180 ? n - 360 : n;
}

/** 速度 v、方向 a（度）→ (东, 北) 分量 */
export function vecFromPolar(speed: number, dirDeg: number): Vec2 {
  const a = dirDeg * DEG2RAD;
  return { east: speed * Math.sin(a), north: speed * Math.cos(a) };
}

/** 风从 fromDeg 度吹来 → 风向量（指向其反方向） */
export function windVector(windSpeed: number, windFromDeg: number): Vec2 {
  const v = vecFromPolar(windSpeed, windFromDeg);
  return { east: -v.east, north: -v.north };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { east: a.east + b.east, north: a.north + b.north };
}

export function magnitude(v: Vec2): number {
  return Math.hypot(v.east, v.north);
}

/** 向量方向（度，[0,360)）；零向量返回 undefined，绝不假造正北。 */
export function directionOf(v: Vec2): number | undefined {
  if (magnitude(v) <= ABS_TOL) return undefined;
  return normalize360(Math.atan2(v.east, v.north) * RAD2DEG);
}

function assertFinite(value: number, name: string): void {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new InputError("NON_FINITE", `${name} 必须是有限数值，收到: ${String(value)}`);
  }
}

export interface WindInput {
  /** 真空速，必须 > 0 */
  tas: number;
  /** 风速，可 >= 0 */
  windSpeed: number;
  /** 风从哪里来（度，任意有限值，内部规范化） */
  windFrom: number;
}

export interface Units {
  /** 速度单位（单一声明单位，所有速度一致使用） */
  speed: string;
  /** 距离单位（可选，与速度单位对应，如 kt↔nm） */
  distance?: string;
}

export const DEFAULT_UNITS: Units = { speed: "kt", distance: "nm" };

function validateWind(input: WindInput): void {
  assertFinite(input.tas, "tas");
  assertFinite(input.windSpeed, "windSpeed");
  assertFinite(input.windFrom, "windFrom");
  if (input.tas <= 0) throw new InputError("NON_POSITIVE_TAS", "真空速 tas 必须为正数");
  if (input.windSpeed < 0) throw new InputError("NEGATIVE_WIND", "风速 windSpeed 不能为负");
}

function assertResultFinite(v: Vec2): void {
  if (!Number.isFinite(v.east) || !Number.isFinite(v.north)) {
    throw new InputError("RESULT_OVERFLOW", "计算结果溢出或非有限值，输入被拒绝");
  }
}

export interface ForwardRequest extends WindInput {
  /** 真航向（度，任意有限值） */
  trueHeading: number;
  /** 可选航段距离（正数），用于计算航段时间 */
  distance?: number;
  units?: Units;
}

export interface ForwardResult {
  kind: "forward";
  status: "ok" | "stationary";
  units: Units;
  input: {
    tas: number;
    trueHeading: number;
    windSpeed: number;
    windFrom: number;
    distance?: number;
  };
  airVector: Vec2;
  windVector: Vec2;
  groundVector: Vec2;
  groundSpeed: number;
  /** 地速接近零时为 null（未定义），不由 atan2(0,0) 假造正北 */
  groundTrack: number | null;
  /** 航段时间（小时，distance/groundSpeed）；无正向地速时为 null */
  legTimeHours: number | null;
  toleranceVersion: string;
}

export function forward(req: ForwardRequest): ForwardResult {
  validateWind(req);
  assertFinite(req.trueHeading, "trueHeading");
  let distance: number | undefined;
  if (req.distance !== undefined) {
    assertFinite(req.distance, "distance");
    if (req.distance <= 0) throw new InputError("NON_POSITIVE_DISTANCE", "distance 必须为正数");
    distance = req.distance;
  }
  const units: Units = { ...DEFAULT_UNITS, ...(req.units ?? {}) };

  const heading = normalize360(req.trueHeading);
  const windFrom = normalize360(req.windFrom);

  const air = vecFromPolar(req.tas, heading);
  const wind = windVector(req.windSpeed, windFrom);
  const ground = add(air, wind);
  assertResultFinite(ground);
  const gs = magnitude(ground);
  const track = directionOf(ground);
  const stationary = track === undefined;

  return {
    kind: "forward",
    status: stationary ? "stationary" : "ok",
    units,
    input: { tas: req.tas, trueHeading: heading, windSpeed: req.windSpeed, windFrom, distance },
    airVector: air,
    windVector: wind,
    groundVector: ground,
    groundSpeed: gs,
    groundTrack: track ?? null,
    legTimeHours: distance !== undefined && !stationary ? distance / gs : null,
    toleranceVersion: TOLERANCE_VERSION,
  };
}

export interface InverseRequest extends WindInput {
  /** 期望真航迹（度，任意有限值） */
  desiredTrack: number;
  distance?: number;
  units?: Units;
}

export interface InverseCandidate {
  /** 纵向分支：沿航迹空速取 +sqrt 或 -sqrt */
  branch: "+" | "-";
  /** 所需真航向（度，[0,360)） */
  trueHeading: number;
  /** 航向修正角 = 航向 - 航迹，规范化到 [-180,180)，保留左右符号 */
  correctionAngle: number;
  /** 沿目标方向的地速（严格为正） */
  groundSpeed: number;
  airVector: Vec2;
  groundVector: Vec2;
  /** 回代核验：地速在航迹右侧方向的残差（应≈0） */
  crossTrackResidual: number;
  /** 回代核验：地速在目标方向上的投影（应≈groundSpeed） */
  alongTrackProjection: number;
  legTimeHours: number | null;
}

export interface InverseResult {
  kind: "inverse";
  status: "no-solution" | "one-solution" | "two-solutions";
  units: Units;
  input: {
    tas: number;
    desiredTrack: number;
    windSpeed: number;
    windFrom: number;
    distance?: number;
  };
  /** 风在航迹方向 / 航迹右侧方向上的分量 */
  windAlongTrack: number;
  windCrossTrack: number;
  candidates: InverseCandidate[];
  toleranceVersion: string;
}

export function inverse(req: InverseRequest): InverseResult {
  validateWind(req);
  assertFinite(req.desiredTrack, "desiredTrack");
  let distance: number | undefined;
  if (req.distance !== undefined) {
    assertFinite(req.distance, "distance");
    if (req.distance <= 0) throw new InputError("NON_POSITIVE_DISTANCE", "distance 必须为正数");
    distance = req.distance;
  }
  const units: Units = { ...DEFAULT_UNITS, ...(req.units ?? {}) };

  const track = normalize360(req.desiredTrack);
  const windFrom = normalize360(req.windFrom);

  const u = vecFromPolar(1, track); // 目标航迹单位向量
  const r: Vec2 = { east: u.north, north: -u.east }; // 航迹右侧单位向量
  const wind = windVector(req.windSpeed, windFrom);

  const wParallel = wind.east * u.east + wind.north * u.north;
  const wCross = wind.east * r.east + wind.north * r.north;

  const tas = req.tas;
  const base = {
    kind: "inverse" as const,
    units,
    input: { tas, desiredTrack: track, windSpeed: req.windSpeed, windFrom, distance },
    windAlongTrack: wParallel,
    windCrossTrack: wCross,
    toleranceVersion: TOLERANCE_VERSION,
  };

  // 侧风需求超出空速能力：无解。容差只用于“恰好等于”的边界，不做宽泛裁剪。
  if (Math.abs(wCross) > tas * (1 + REL_TOL) + ABS_TOL) {
    return { ...base, status: "no-solution", candidates: [] };
  }

  // 根号项：仅当因浮点微差略小于零时归零
  let radicand = tas * tas - wCross * wCross;
  if (radicand < 0) {
    if (radicand >= -(ABS_TOL + REL_TOL * tas * tas)) radicand = 0;
    else return { ...base, status: "no-solution", candidates: [] };
  }
  const s = Math.sqrt(radicand);

  // 根号接近零时两分支重合，只保留一个。
  // 带宽按 sqrt(相对容差) 缩放：三角函数求 wCross 的浮点误差经平方根放大后约为此量级。
  const mergeBand = Math.sqrt(REL_TOL) * Math.max(tas, Math.abs(wCross), 1) + ABS_TOL;
  const branches: Array<{ branch: "+" | "-"; along: number }> = [{ branch: "+", along: s }];
  if (s > mergeBand) {
    branches.push({ branch: "-", along: -s });
  }

  const candidates: InverseCandidate[] = [];
  for (const b of branches) {
    const gs = wParallel + b.along;
    // 只有严格为正（超出容差）的地速才能沿目标方向前进
    if (gs <= ABS_TOL + REL_TOL * Math.max(1, Math.abs(wParallel))) continue;

    // 空速向量 = 侧向补偿(-wCross·r) + 纵向(b.along·u)
    const air: Vec2 = {
      east: -wCross * r.east + b.along * u.east,
      north: -wCross * r.north + b.along * u.north,
    };
    // 回代核验：用真实向量 ground = air + wind，而非复制目标角
    const ground = add(air, wind);
    assertResultFinite(ground);
    const heading = directionOf(air);
    if (heading === undefined) continue; // 空速向量退化（tas>0 时不会发生）

    candidates.push({
      branch: b.branch,
      trueHeading: heading,
      correctionAngle: normalize180(heading - track),
      groundSpeed: magnitude(ground),
      airVector: air,
      groundVector: ground,
      crossTrackResidual: ground.east * r.east + ground.north * r.north,
      alongTrackProjection: ground.east * u.east + ground.north * u.north,
      legTimeHours: distance !== undefined ? distance / magnitude(ground) : null,
    });
  }

  // 按地速从大到小排序
  candidates.sort((a, b) => b.groundSpeed - a.groundSpeed);

  const status =
    candidates.length === 0 ? "no-solution" : candidates.length === 1 ? "one-solution" : "two-solutions";
  return { ...base, status, candidates };
}
