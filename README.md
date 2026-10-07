# 平面风三角航向修正与地速可达性后端（教学用）

使用 TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，零运行时依赖）实现的
教学用平面风三角计算服务，只提供 HTTP API 与 CLI，无图形界面。

**范围声明**：只处理一个局部平面和恒定风。不读取天气、不接地图、不做球面航线、
不做飞机性能模型，**不构成真实飞行指导**。

## 模型约定

- 坐标系：局部东-北平面。方向 `a`（度）自正北起顺时针计量。
- 速度 `v`、方向 `a` 对应向量：`(东, 北) = (v·sin(a), v·cos(a))`。
- 核心关系：**地速向量 = 空速向量 + 风向量**（`ground = air + wind`）。
- **风从向 vs 风向量**：`windFrom` 表示风“从哪里来”（气象惯例），风向量指向其
  反方向。北风（`windFrom=0`）指向南；东风（`windFrom=90`）指向西。
  这与“速度向量指向运动方向”的约定相反，必须区分。
- 单位：所有速度使用请求声明的同一单位（默认 `kt`），距离单位需与速度单位对应
  （默认 `nm`），航段时间（小时）= 距离 / 地速。
- 容差：版本 `tol-v1`，绝对容差 `1e-9`、相对容差 `1e-9`。仅当根号项因浮点微差
  略小于零时归零；明显不可达的侧风不会被宽泛裁剪。

## 多解的来源

反算时，风被分解为沿航迹分量 `w_parallel` 与右侧分量 `w_cross`。飞机必须提供
`-w_cross` 的侧向空速；若 `|w_cross| > tas` 则该航迹不可达（无解）。沿航迹空速为
`±sqrt(tas² - w_cross²)`，两个分支分别加 `w_parallel` 得到候选地速，只有严格为正
的分支能沿目标方向前进。强顺风时 `-sqrt` 分支仍为正——飞机朝反方向飞也会被风吹
向目标方向——于是产生**第二解**。每个候选都代回 `ground = air + wind` 用真实向量
核验，返回横向残差与目标方向投影。根号接近零时两分支重合，只保留一个。

结果状态四选一：`ok` / `stationary`（正算）、`no-solution` / `one-solution` /
`two-solutions`（反算），不以空数组笼统代表全部情况。

## 运行要求

- Windows 本地，Node.js ≥ 22.5（`node:sqlite` 内置，建议 ≥ 24）；不需要
  Docker、WSL、付费服务或外部在线 API。

## 命令

```powershell
npm install      # 安装开发依赖（typescript）
npm run build    # 编译到 dist/
npm test         # 构建并运行全部测试
npm start        # 启动 API 服务（默认端口 0 = 自动选择空闲端口；PORT=8080 可指定）
npm run demo     # 运行教学演示，结果写入 data/demo/
```

CLI（先 `npm run build`）：

```powershell
node dist/src/cli.js forward --tas 100 --heading 0 --wind-speed 60 --wind-from 90 --distance 160
node dist/src/cli.js inverse --tas 100 --track 0 --wind-speed 150 --wind-from 180
node dist/src/cli.js batch cases.json     # cases.json 为 [{mode, input}, ...]，上限 100
node dist/src/cli.js explain              # 分量解释
node dist/src/cli.js reports              # 列出已保存报告
node dist/src/cli.js export 1 --format csv
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/forward` | 正算：`{tas, trueHeading, windSpeed, windFrom, distance?, units?}` |
| POST | `/api/inverse` | 反算：`{tas, desiredTrack, windSpeed, windFrom, distance?, units?}` |
| POST | `/api/batch` | 批量：`{cases:[{mode,input}]}`，上限 100，失败项独立报告 |
| GET | `/api/explain` | 分量解释（文本） |
| GET | `/api/reports` | 报告列表 |
| GET | `/api/reports/:id` | 查看冻结报告 |
| GET | `/api/reports/:id/export?format=json\|csv` | 导出 |
| GET | `/api/health` | 健康检查 |

错误以 `{error:{code,message}}` 返回，错误码包括：`NON_FINITE`、`NON_POSITIVE_TAS`、
`NEGATIVE_WIND`、`NON_POSITIVE_DISTANCE`、`RESULT_OVERFLOW`、`BAD_JSON`、`BAD_INPUT`、
`BAD_MODE`、`BATCH_TOO_LARGE`、`NOT_FOUND`、`BAD_FORMAT`。

## 持久化

SQLite 数据库保存在项目内 `data/wind-triangle.db`。每份报告保存原输入、规范化角度、
单位、容差版本与全部候选；报告只新增不改写——切换风向或参数生成新报告，重复请求
（按规范化请求哈希判定）返回原结果并标记 `replayed: true`。

## 教学示例

1. 真空速 100 向北、东风 60：正向地速向量为东 -60、北 100；若目标航迹正北，
   所需航向 ≈ 36.86989765°，地速 80。
2. 向北顺风 150（南风）、空速 100、目标航迹正北：两解——朝北飞地速 250；
   朝南飞也被风吹向北，地速 50。

## 已知限制

- 仅平面模型，不考虑地球曲率、磁差、高度与性能变化。
- 风恒定且单一，无阵风与垂直分量。
- 时间单位固定为小时（距离单位 / 速度单位需对应，如 nm/kt）。
- `node:sqlite` 在 Node 25 仍标记为实验特性，启动时有实验警告，不影响功能。
