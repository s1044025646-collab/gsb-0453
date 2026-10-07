# 平面风三角航向修正与地速可达性后端

教学用的平面风三角计算服务，仅含 **API + CLI**，无前端、无绘图库。使用 TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生依赖、无外部服务），Windows 本地直接运行。

## 范围与限制

- 只处理一个**局部平面**和**固定风**：不读取天气、不接地图、不做球面航线、不建模飞机性能，**不构成真实飞行指导**。
- 单位统一声明为：速度 **kt（节）**、距离 **nm（海里）**、时间 **h（小时）**（kt = nm/h，三者自洽）。
- 方向为自正北顺时针的度数，任意有限角度输入都会规范化到 `[0, 360)`。

## 核心约定（务必区分）

- **风向 = 风从哪里来**。风向量是该方向的**反**向量：北风（自 0°）指向南，东风（自 90°）指向西。
- 速度 `v`、方向 `a` 的分量：`(east = v·sin(a), north = v·cos(a))`。
- 核心向量关系：**ground = air + wind**（地速向量 = 空速向量 + 风向量）。

## 正算（forward）

输入真空速、真航向、恒定风，输出空速向量、风向量、地速向量、地速大小与规范化航迹。
地速接近零时 `kind = "stationary"` 且 `track = null`（方向未定义，**不由 atan2(0,0) 伪造正北**）。

## 反算（inverse）与多解来源

给定期望真航迹单位向量 `u` 及其右侧单位向量 `r`（航迹 +90°），把风分解为：

- `w_parallel = wind·u`（沿航迹分量，正为顺风）
- `w_cross = wind·r`（右侧分量）

飞机必须以空速提供 `-w_cross` 的侧向分量，因此要求 `|w_cross| ≤ TAS`，否则**无解**。
剩余沿航迹空速为 `±sqrt(TAS² − w_cross²)`，分别加 `w_parallel` 得到两个候选地速，
**只有严格为正的分支**能沿目标方向前进。因此在强顺风下会出现**两解**：
朝目标方向飞（快），或朝反方向飞、让强顺风把飞机吹向目标（慢）。
根号接近零时两分支重合，只保留一个候选。结果按地速降序输出，并给出所选纵向分支与航向。

每个候选都会代回 `ground = air + wind` 用**真实向量**核验，返回横向残差
（应≈0）与目标方向投影（应=地速），而不是把目标角直接复制成输出。

结果类型明确区分：`no_solution` / `unique` / `two_solutions`（反算）与
`moving` / `stationary`（正算），不用空数组笼统代表全部情况。

## 数值容差

容差版本 `tol-v1`：`ABS_TOL = REL_TOL = 1e-9`。
只有因浮点微差略小于零的根号项才归零；明显不可达的侧风（`|w_cross|` 明显大于 TAS）不会被宽泛裁剪。
航向修正角统一规范化到 `[-180, 180)`，保留左右符号。

## 校验与错误码

- 真空速必须为正；风速可为零但不能为负；可选距离必须为正。
- NaN、无穷、负速度与结果溢出均被拒绝。
- 错误码：`E_NOT_FINITE`、`E_TAS_NOT_POSITIVE`、`E_WIND_NEGATIVE`、`E_DISTANCE_NOT_POSITIVE`、
  `E_OVERFLOW`、`E_BAD_JSON`、`E_MODE_UNKNOWN`、`E_BATCH_NOT_ARRAY`、`E_BATCH_TOO_LARGE`（上限 100）、
  `E_NOT_FOUND`、`E_ROUTE_NOT_FOUND`、`E_INTERNAL`。

## 运行

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm start         # 启动 API（默认自动选择空闲端口；也可 --port 指定）
npm run demo      # 内置演示
```

要求 Node.js ≥ 22.5（内置 `node:sqlite`），开发使用 Node 25 验证。无需 Docker / WSL / 外部 API。
数据库与演示生成物保存在项目内 `data/` 目录（可用环境变量 `WIND_DB` 覆盖数据库路径）。

## CLI

```powershell
node dist/src/cli.js serve [--port N]
node dist/src/cli.js forward --tas 100 --heading 0 --wind-speed 60 --wind-from 90 [--distance 100]
node dist/src/cli.js inverse --tas 100 --track 0 --wind-speed 150 --wind-from 180
node dist/src/cli.js batch --file examples/cases.json
node dist/src/cli.js explain --id 2
node dist/src/cli.js report --id 2
node dist/src/cli.js reports
node dist/src/cli.js export --id 2 --format csv --out data/report2.csv
node dist/src/cli.js demo
```

CLI 直接打印东/北分量表与候选表（分支、航向、修正角、地速、横向残差、沿向投影、航段时间）。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/forward` | 正算，body: `{tas, heading, windSpeed, windFrom, distance?}` |
| POST | `/api/inverse` | 反算，body: `{tas, track, windSpeed, windFrom, distance?}` |
| POST | `/api/batch` | 批量工况，body: `{cases: [{mode, ...}, ...]}`，上限 100，失败项独立报告 |
| GET | `/api/reports` | 最近报告列表 |
| GET | `/api/reports/:id` | 查看冻结报告 |
| GET | `/api/reports/:id/explain` | 分量解释（约定、向量、风分解、候选核验） |
| GET | `/api/reports/:id/export?format=json\|csv` | 导出报告 |

未指定端口时服务自动选择空闲端口并打印实际地址。

## 持久化与幂等

SQLite 保存原始输入、规范化角度、单位、容差版本与全部候选。报告写后冻结：
切换风向或参数会生成**新**报告，绝不重写旧结论。相同请求（按规范化请求 + 容差版本的
SHA-256）命中已有报告并标记 `reused: true`，重启后结果一致。

## 演示用例（`npm run demo`）

1. TAS=100 向北、东风 60：风向量 `(east=-60, north=0)`，地速向量 `(-60, 100)`。
2. 目标航迹正北、同样的风：所需航向 ≈ **36.86989765°**，地速 **80 kt**。
3. 顺风 150（风自南来）、TAS=100、目标正北：**两解** —— 朝北地速 250；朝南也能随风向北 50。

## 测试覆盖

静风、恰好侧风（根号归零去重）、不可达侧风、过强逆风、角度回绕、零地速（航迹未定义）、
整体旋转保持速度大小、反算回代方向核验、两候选去重、幂等与重启一致性、批量失败隔离与上限、
JSON/CSV 导出、参数校验。
