# thin-airfoil-service

一个常驻运行的 HTTP 服务，用于按**薄翼理论**快速评估弯度线（camber line）：
喂入一条弯度线和一个攻角（**弧度**），返回升力系数 `Cl`、绕四分之一弦点的
力矩系数 `Cm,c/4`、零升攻角 `αL0`，以及沿弦载荷分布 `ΔCp(x)`。专为设计脚本
批量驱动而做：单翼型单攻角、攻角扫描、混合批量、具名档案持久化，以及从气动
目标**反解**弯度线（`POST /inverse`）。

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

### `POST /inverse` — 反解：从气动目标综合弯度线

正向评估是"先有弯度线、再出气动力"；本接口反向走：先给气动目标，服务综合出
一条能实现它的弯度线。三档目标由轻到重（`cl` / `cl`+`cmQuarter` / `loading`）：

```bash
# 档位 1：参考攻角下想要的升力
curl -s localhost:8080/inverse -H 'content-type: application/json' -d '{
  "alpha": 0.0, "cl": 0.6
}'

# 档位 2：再钉住四分之一弦点力矩（也可给区间 {"min":..,"max":..}）
curl -s localhost:8080/inverse -H 'content-type: application/json' -d '{
  "alpha": 0.0, "cl": 0.4, "cmQuarter": -0.05
}'

# 档位 3：直接给一条沿弦想要的无量纲载荷 ΔCp（按弦向严格单调递增的采样）
# 采样点位置可用 x∈(0,1) 或 θ∈(0,π)，至少 8 个、不可含端点
curl -s localhost:8080/inverse -H 'content-type: application/json' -d '{
  "alpha": 0.02,
  "loading": [ {"x": 0.01, "deltaCp": 2.31}, {"x": 0.02, "deltaCp": 1.84} ]
}'
```

请求字段：

| 字段 | 含义 |
| --- | --- |
| `alpha` | 参考攻角（**弧度**，必填）。超过 15° 适用线按正向同样规则拒绝/打标 |
| `cl` | 该攻角下想要的升力系数（档位 1/2） |
| `cmQuarter` | 想要的 `Cm,c/4`：精确数或闭区间 `{min,max}`（档位 2/3） |
| `loading` | 沿弦载荷采样 `[{x\|theta, deltaCp}]`（档位 3，≥8 个、严格单调、内点） |
| `allowOutOfRange` | 放行超出 15° 适用线的有效前缘攻角并置 `outOfRange`（默认 false） |
| `output` | `auto`（默认）/`polynomial`/`points`，弯度线表示选择 |
| `bounds` | `{maxCamber?, maxSlope?}` 几何设计包络，给 `null` 显式关闭该项 |
| `samples` | 离散点弯度线的采样数（1024–2048，默认 1201，余弦聚点；下限保证离散线闭环进容差） |
| `register` | 给 `{id, name?, description?}` 时，把**已通过闭环验收**的弯度线登记成具名档案 |

返回含：`camber`（多项式或离散点两种**既有**表示之一，可直接回喂 `/analyze`、
`/sweep`、批量请求或登记档案）、`prediction`（αL0/Cl/Cm/Glauert 系数）、
`selectionCriterion`（定解准则与实际启用的谐波）、`verification`（把结果重新喂进
**未改动的正向内核**算回目标的误差与容差）、`diagnostics`（最大弯度/斜率、
后缘闭合残差、谐波系数等）。

**定解准则（唯一、确定、可复现）**：反解天生欠定。服务统一取

> 在满足目标与闭合规范 `z(0)=z(1)=0` 的所有弯度线中，保留阶数最低的 Glauert
> 斜率谐波；约束未钉住的谐波一律恒为零（最小弯度/最低阶解）。

- 档位 1：仅 `b₁ cosθ`，得到唯一的最低阶抛物线 `z=b₁x(1−x)`；
- 档位 2：`{b₀,b₁,b₂}`（`b₀=b₂/3` 由后缘闭合固定），得到唯一的三次弯度；
  力矩给区间时取区间内能最小点 `d*=4L/7`，落不进区间则夹到最近端点；
- 档位 3：对载荷做**阶数截断**（≤12 阶，随采样数自适应）的最小二乘拟合，
  后缘闭合作为恒等 KKT 约束；钉住的 `cl`/`cmQuarter` 作为精确等式约束。

不含任何随机性，同样的目标永远得到同一条弯度线；准则 id 与启用谐波随结果返回。

**闭环自洽（硬要求，自动化测试钉死）**：综合出的弯度线必被正向评估原样收下，
并在写明的容差内复现目标——

| 量 | 容差 |
| --- | --- |
| 升力 `clError` | `1e-6` |
| 力矩 `cmError`（被钉住时） | `1e-5` |
| 载荷 `loadingRmsError`（档位 3） | `2e-2` |

自验不过服务直接报 `INTERNAL`（属于服务缺陷而非客户端错误），绝不返回一条
验不回去的线。

**薄翼理论下不可实现/自相矛盾的目标**在开解前按类型结构化拒绝：对称载荷给不出
非零力矩（`TARGET_INCONSISTENT`，附 `reason: SYMMETRIC_LOADING_ZERO_MOMENT`）、
载荷积分与其钉住的 `cl`/力矩区间打架（`TARGET_INCONSISTENT`）、闭合弯度在该参考
攻角下无法承载该载荷即后缘必然开口（`TARGET_UNACHIEVABLE`）、所需最大弯度/斜率
超几何包络或有效前缘攻角 `|A0|` 超 15°（`TARGET_UNACHIEVABLE`，可显式放行后者）。
载荷太稀/不单调/含端点/坐标混用则为 `INVALID_LOADING`；没有任何目标为
`INVALID_TARGET`。

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
| `INVALID_TARGET` | 反解请求缺目标（既无 `cl` 也无 `loading`）/区间倒置/表示选择不合法（400） |
| `INVALID_LOADING` | 载荷采样太少（<8）、不单调、含弦向端点、x/θ 混用或含非有限值（422） |
| `TARGET_INCONSISTENT` | 目标自相矛盾：对称载荷要非零力矩、载荷与钉住的 Cl/Cm（区间）打架（422） |
| `TARGET_UNACHIEVABLE` | 薄翼理论/闭合约束/几何包络下无法实现：后缘开口、弯度过大、有效攻角超线（422） |

## 模块划分

| 文件 | 职责 |
| --- | --- |
| `src/camber.ts` | 输入校验、θ 变换下的斜率与 cosine 矩（多项式 Simpson / 离散点闭式精确积分） |
| `src/analyze.ts` | α 合法性、αL0 积分、Glauert 系数、Cl/Cm、ΔCp 载荷与积分回收 |
| `src/inverse.ts` | **反解**：升力 / 升力+力矩 / 载荷三档目标综合弯度线（最低 Glauert 阶准则、KKT 约束最小二乘），并用未改动的正向内核做闭环验收 |
| `src/validation.ts` | Zod 请求结构校验（含 `/inverse` 载荷/区间/包络/登记体） |
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
