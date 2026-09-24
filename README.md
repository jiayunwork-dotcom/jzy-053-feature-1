# thin-airfoil-service

一个常驻运行的 HTTP 服务，用于按**薄翼理论**快速评估弯度线（camber line）：
喂入一条弯度线和一个攻角（**弧度**），返回升力系数 `Cl`、绕四分之一弦点的
力矩系数 `Cm,c/4`、零升攻角 `αL0`，以及沿弦载荷分布 `ΔCp(x)`。专为设计脚本
批量驱动而做：单翼型单攻角、攻角扫描、混合批量、具名档案持久化。

同时支持**反解（inverse design）**：从想要的气动目标（升力、升力+力矩，或一条
沿弦载荷走势）反推出一条弯度线，结果可直接被正向 `/analyze` 原样收下并在容差内
复现目标。

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

### 反解（inverse design）

从气动目标反推弯度线，三档目标都接得住。反解天生欠定（同一 `Cl` 背后有无数条
弯度线），服务用一条**可复现、有物理依据的定解准则**把解收敛到唯一，并随结果
一起返回：

> **最小斜率能量（least bending-energy / Riesz 最小范数）弯度线**：在满足钉住
> 的气动约束、且后缘闭合 `z(1)=0` 的所有弯度线中，最小化
> `E = (1/π) ∫ (dz/dx)² dθ`。这是薄翼中弧线弯曲代价的主项，选出的是**最平滑、
> 最低阶**的那条。约束都是斜率的线性泛函，最小化子是其 Riesz 表示子的有限线性
> 组合，闭式求解、无随机搜索，同一目标永远给出同一条线。

产物始终是现有两种弯度表示之一的**离散点（points）**，合成时每段常数斜率取最小
能量斜率在该 θ 单元上的精确平均，因此正向评估能高精度复现目标；可直接 `/analyze`，
也可 `saveAs` 登记成具名档案被 `/sweep`、`/analyze/batch` 复用。

每次响应都带 `criterion`（准则名、施加的约束、谐波阶数、是否闭合后缘、合成段数）
和 `verification`（把结果重新正向评估得到的 `cl/cmQuarter`、与目标的绝对误差、
所用容差、`passed`）。默认闭环容差 `|ΔCl| ≤ 2e-3`、`|ΔCm| ≤ 5e-4`，可用
`tolerance` 收紧或放宽。

#### `POST /design/lift` — 升力档 / 升力+力矩档

```bash
# 最轻一档：参考攻角 + 该攻角下想要的 Cl
curl -s localhost:8080/design/lift -H 'content-type: application/json' -d '{
  "alpha": 0.03, "cl": 0.5
}'

# 上一档：再钉住四分之一弦点力矩
curl -s localhost:8080/design/lift -H 'content-type: application/json' -d '{
  "alpha": 0.03, "cl": 0.5, "cmQuarter": -0.05,
  "tolerance": { "cl": 1e-4, "cmQuarter": 1e-5 },
  "saveAs": "cruise-section"
}'
```

字段：`alpha`（弧度，参考攻角）、`cl`、可选 `cmQuarter`、可选 `symmetric`
（要求对称翼）、可选 `tolerance`、可选 `saveAs`（顺带登记档案，可附 `name`/
`description`）。

- 力矩只由弯度高阶谐波 `(A2−A1)` 决定、与攻角无关。**对称翼在任何攻角下
  `Cm,c/4` 恒为 0**，因此 `symmetric:true` 又给非零 `cmQuarter` 是自相矛盾，
  在动手求解前就返回 `TARGET_INCONSISTENT` 并说明缘由，绝不硬憋一条离谱的线。
- 要的升力必须靠远超薄翼范围的弯度/斜率（或参考攻角越过 15°）才能凑出来时，
  返回 `TARGET_UNREALIZABLE`，details 里带产生的/允许的最大斜率与弯度。
- `symmetric:true` 且 `Cl = 2πα` 时返回平板线；对称限制下达不到该升力则
  `TARGET_UNREALIZABLE`。

返回体：

```json
{
  "camber": { "kind": "points", "points": [ {"x":0,"z":0}, ... ] },
  "alpha": 0.03,
  "targets": { "cl": 0.5, "cmQuarter": -0.05 },
  "criterion": {
    "name": "minimum_slope_energy",
    "description": "...",
    "constraints": ["cl_target", "cm_quarter_target", "closed_trailing_edge"],
    "harmonicOrder": 2, "closedTrailingEdge": true, "segments": 512
  },
  "verification": {
    "cl": 0.49993, "cmQuarter": -0.04998,
    "clError": 6.6e-5, "cmQuarterError": 1.6e-5,
    "tolerance": { "cl": 0.001, "cmQuarter": 0.00001 }, "passed": true
  },
  "diagnostics": { "maxCamber": 0.0438, "maxSlope": 0.251 },
  "savedProfile": { "id": "cruise-section" }
}
```

#### `POST /design/loading` — 载荷走势档

直接递一条沿弦无量纲载荷 `ΔCp(x)` 走势（`x` 严格单调递增、落在开弦 `(0,1)` 内，
至少 8 个采样）：

```bash
curl -s localhost:8080/design/loading -H 'content-type: application/json' -d '{
  "alpha": 0.02,
  "loading": [ {"x": 0.01, "deltaCp": 4.2}, {"x": 0.05, "deltaCp": 2.6}, "...": "..." ],
  "order": 8, "saveAs": "tailored-loading"
}'
```

做法：先用 `sin θ` 加权最小二乘把采样降为固定低阶 Glauert 谐波集（默认
`order = 8`，即这一档的定解/正则化阶数），再强制后缘闭合、按同样的单元平均斜率
合成弯度线。`verification.loadingShapeFit` 给加权 RMS 与相对 RMS，量化走势（而不
仅是积分出的 Cl/Cm）被复现得多好。采样太稀 → `LOADING_TOO_FEW_SAMPLES`，不单调
→ `LOADING_NOT_MONOTONIC`（带 `index`），落在端点/越界/含非有限数 →
`LOADING_MALFORMED`，都在开解前挡下。

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
| `TARGET_INCONSISTENT` | 反解目标自相矛盾（如要求对称翼又要非零力矩，422） |
| `TARGET_UNREALIZABLE` | 目标在薄翼理论/几何包线内无法实现（422，带缘由与限值） |
| `LOADING_TOO_FEW_SAMPLES` | 载荷采样少于 8 个（422，带 `count/minimum`） |
| `LOADING_NOT_MONOTONIC` | 载荷采样 x 非严格单调递增（422，带 `index`） |
| `LOADING_MALFORMED` | 载荷采样项非法、x 落在端点/越界等（422） |
| `INVERSE_TOLERANCE_NOT_MET` | 反解弯度在请求的容差内无法复现目标（容差过紧，422，带实际误差） |

## 模块划分

| 文件 | 职责 |
| --- | --- |
| `src/camber.ts` | 输入校验、θ 变换下的斜率与 cosine 矩（多项式 Simpson / 离散点闭式精确积分） |
| `src/analyze.ts` | α 合法性、αL0 积分、Glauert 系数、Cl/Cm、ΔCp 载荷与积分回收 |
| `src/inverse.ts` | 反解：最小斜率能量定解、表示子/约化 Gram 求解、载荷谐波最小二乘、闭合离散点合成与正向闭环校验（独立模块，不揉入正向评估） |
| `src/validation.ts` | Zod 请求结构校验（含反解请求） |
| `src/profileStore.ts` | 具名档案登记与磁盘持久化（原子写、串行化写链） |
| `src/service.ts` | 档案/临时弯度解析、正向计算编排、反解与可选档案登记 |
| `src/routes.ts` / `app.ts` / `index.ts` | HTTP 路由（含 `/design/lift`、`/design/loading`）、错误边界、启动 |
| `test/*.test.ts` | 理论交叉关系、单位一致性、非法几何、持久化、反解闭环/定解准则/三档/不可实现、HTTP、并发 |

## 测试钉死的交叉关系

- 对称翼：αL0=0 且 Cl/α ≡ 2π；Cm ≡ 0
- 弯度整体乘 k：αL0 与 Cl(0) 同步乘 k（含负 k）
- Cm,c/4 不随攻角变化；α = αL0 时 Cl 严格为 0
- 载荷分布积分回收同一个 Cl（另有对返回采样网格的独立积分）
- 离散点加密收敛到多项式解；`chord` 缩放等价于已归一化输入
- 单位守卫：15° 换算成弧度（≈0.2618）放行，而把裸数字 15（度直接塞进
  弧度公式）判为超界——度/弧度混用不可能蒙混出一条升力曲线

## 反解测试钉死的闭环

- 三档目标（升力、升力+力矩、载荷走势）反解出的弯度线，重新喂回 `/analyze`
  后，Cl（及被钉住的 Cm）在写明容差内回到目标值（独立重算，不信模块自评）
- 定解准则随结果返回；同一目标确定性地给出**完全相同**的弯度；叠加一个与约束
  正交、保持 Cl 与闭合的 cos3 斜率扰动只会抬高斜率能量（验证最小能量性）
- 对称翼+非零力矩 `TARGET_INCONSISTENT`；过大升力/超界攻角 `TARGET_UNREALIZABLE`
- 载荷采样太稀/不单调/端点或非法，在求解前分别以对应错误码挡下
- 反解结果可用 `saveAs` 登记，随后被 `/analyze`、`/sweep` 复用
- 多个反解请求并发时各自的弯度与目标互不串台
