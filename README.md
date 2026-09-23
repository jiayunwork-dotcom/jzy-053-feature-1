# thin-airfoil-service

一个常驻运行的 HTTP 服务，用于按**薄翼理论**快速评估弯度线（camber line）：
喂入一条弯度线和一个攻角（**弧度**），返回升力系数 `Cl`、绕四分之一弦点的
力矩系数 `Cm,c/4`、零升攻角 `αL0`，以及沿弦载荷分布 `ΔCp(x)`。专为设计脚本
批量驱动而做：单翼型单攻角、攻角扫描、混合批量、具名档案持久化。

- 运行时：**Node.js 20 + TypeScript**（Web 框架 Express，校验 Zod）
- 攻角全程使用**弧度**；超过 **15°（≈0.2618 rad）** 默认拒绝（可显式放行并打标）
- 源码按职责拆分为独立模块（校验 / θ 变换与 αL0 积分 / 系数与载荷 / 持久化 / HTTP）

## 理论约定

角标变换

```
x = (1 − cos θ)/2,   θ ∈ [0, π]
```

设弯度斜率 η(θ) = dz/dx，Glauert 系数

```
A0 = α − (1/π)∫₀^π η(θ) dθ
An =  (2/π)∫₀^π η(θ) cos(nθ) dθ
```

零升攻角（只由弯度决定，被积式中的 `(cosθ − 1)` 权因子不可省）：

```
αL0 = −(1/π)∫₀^π η(θ)(cosθ − 1) dθ = (1/π)∫₀^π η(θ)(1 − cosθ) dθ
```

```
Cl       = 2π (A0 + A1/2) = 2π(α − αL0)
Cm,c/4   = (π/4)(A2 − A1)          # 只依赖弯度高阶分量，不随攻角变化
ΔCp(θ)   = 4 A0 (1+cosθ)/sinθ + 4 Σ An sin(nθ)
∫₀¹ ΔCp dx = Cl                    # 载荷分布积分必须回到同一个 Cl
```

正弯度翼型（如 `z=4hx(1−x)`）有 `αL0 = −2h < 0`，α=0 时产生正升力。

离散点弯度线按段线性插值，每段斜率为常数，所有 cosine 矩用**闭式分段精确积分**；
多项式弯度线的斜率矩用高分辨率 Simpson 求积。

## 快速开始

```bash
npm install
npm run dev          # 直接以 tsx 运行（开发）

npm run build        # tsc 编译到 dist/
npm start            # node dist/index.js

npm test             # 运行全部自动化测试（内置 node:test，无需额外测试框架）
```

环境变量：`PORT`（默认 8080）、`HOST`（默认 0.0.0.0）、
`PROFILES_FILE`（默认 `./data/profiles.json`，原子写、重启保留）。

### 容器

```bash
docker build -t thin-airfoil-service .
docker run -p 8080:8080 -v $(pwd)/data:/data thin-airfoil-service
```

## 弯度线给法

1. 多项式系数（升幂）：`z(x) = c0 + c1 x + c2 x² + ...`
   ```json
   { "kind": "polynomial", "coefficients": [0, 0.2, -0.2] }
   ```
2. 离散采样点（x 必须**严格单调递增**），分段线性插值：
   ```json
   { "kind": "points",
     "points": [{"x": 0, "z": 0}, {"x": 0.5, "z": 0.05}, {"x": 1, "z": 0}] }
   ```
   弦长默认必须已归一化到 `x ∈ [0,1]`；若给的是物理坐标，可提供正的 `chord`
   让服务缩放：`"chord": 2.0`。弦长未归一化且不给 `chord` 会返回结构化错误
   `CHORD_NOT_NORMALIZED`。

## HTTP 接口

所有请求/响应均为 JSON，没有界面。错误统一形如：

```json
{ "error": { "code": "ALPHA_OUT_OF_RANGE",
             "message": "...", "details": { } }
```

### `POST /analyze` — 单翼型单攻角

```bash
curl -s localhost:8080/analyze -H 'content-type: application/json' -d '{
  "camber": {"kind": "polynomial", "coefficients": [0, 0.2, -0.2]},
  "alpha": 0.0
}'
```

返回：`alpha`、`alphaL0`、`cl`、`cmQuarter`、`coefficients {a0,a1,a2}`、
`loading[]`（含 `x/theta/deltaCp`）、`loadingIntegralCl`（载荷积分回算出的 Cl，
与 `cl` 必须一致）、`outOfRange`。

也可以用 `"profile": "<id>"` 代替 `"camber"` 调用已登记档案（二者只能给一个）。
`allowOutOfRange: true` 可在超过 15° 时照常计算并把 `outOfRange` 置真；
`samples`（8–1024）控制返回的载荷点数。

### `POST /sweep` — 单翼型扫攻角

```json
{ "profile": "demo-parabola-5pct",
  "alphaStart": -0.1, "alphaEnd": 0.1, "steps": 20 }
```

`steps` 为区间数，返回 `steps+1` 个点（含端点）。逐点给 `alpha/cl/cmQuarter/
outOfRange`；`includeLoading: true` 时连载荷一起返回。

### `POST /analyze/batch` — 混合批量（彼此隔离）

```json
{ "items": [
  { "id": "a", "camber": {...}, "alpha": 0.05 },
  { "id": "b", "profile": "demo-parabola-5pct", "alpha": 0 }
]}
```

每条独立成败：非法几何/超界攻角只挂自己那一条（`ok:false` + 结构化 `error`），
其余照算。顶层 HTTP 始终 200，逐条看 `ok`。

### 档案

- `GET  /profiles` — 列出
- `POST /profiles` — `{id, name?, description?, camber}`（登记时即校验几何）
- `GET  /profiles/:id`
- `DELETE /profiles/:id`

首启自动预置自检档案 **`demo-parabola-5pct`**：`z(x)=0.2x(1−x)`
（5% 中弧线抛物线）。手算可核对：

```
αL0 = −0.10 rad
Cl(α=0) = 0.2π ≈ 0.6283
Cm,c/4  = −0.05π ≈ −0.1571
```

### `GET /healthz`

存活探针，返回 `{"status":"ok", ...}`。

## 结构化错误码

| code | 含义 |
| --- | --- |
| `INVALID_REQUEST` / `INVALID_JSON` | 请求结构/JSON 不合法 |
| `NON_MONOTONIC_X` | 离散点 x 非严格单调递增（422，带 `index`） |
| `TOO_FEW_POINTS` | 离散点少于 2 个 |
| `CHORD_NOT_NORMALIZED` | x 不落在 [0,1] 且未给 `chord` |
| `INVALID_CHORD` | `chord` 非正/非有限 |
| `INVALID_POLYNOMIAL` | 系数缺失或非有限数 |
| `INVALID_ALPHA` | 攻角非有限数（400） |
| `ALPHA_OUT_OF_RANGE` | 攻角超过 15° 薄翼适用线（422） |
| `INVALID_SWEEP` | 扫描区间倒置等 |
| `PROFILE_NOT_FOUND` / `PROFILE_EXISTS` / `INVALID_PROFILE_ID` | 档案类 |
| `MISSING_CAMBER` / `AMBIGUOUS_CAMBER` | 弯度引用缺失或二义 |

## 模块划分

| 文件 | 职责 |
| --- | --- |
| `src/camber.ts` | 输入校验、θ 变换下的斜率与 cosine 矩（多项式 Simpson / 离散点闭式精确积分） |
| `src/analyze.ts` | α 合法性、αL0 积分、Glauert 系数、Cl/Cm、ΔCp 载荷与积分回收 |
| `src/validation.ts` | Zod 请求结构校验 |
| `src/profileStore.ts` | 具名档案登记与磁盘持久化（原子写、串行化写链） |
| `src/service.ts` | 档案/临时弯度解析与计算编排 |
| `src/routes.ts` / `app.ts` / `index.ts` | HTTP 路由、错误边界、启动 |
| `test/*.test.ts` | 理论交叉关系、单位一致性、非法几何、持久化、HTTP、并发 |

## 测试钉死的交叉关系

- 对称翼：αL0=0 且 Cl/α ≡ 2π；Cm ≡ 0
- 弯度整体乘 k：αL0 与 Cl(0) 同步乘 k（含负 k）
- Cm,c/4 不随攻角变化；α = αL0 时 Cl 严格为 0
- 载荷分布积分回收同一个 Cl（另有对返回采样网格的独立积分）
- 离散点加密收敛到多项式解；`chord` 缩放等价于已归一化输入
- 单位守卫：15° 换算成弧度（≈0.2618）放行，而把裸数字 15（度直接塞进
  弧度公式）判为超界——度/弧度混用不可能蒙混出一条升力曲线
