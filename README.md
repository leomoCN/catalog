# 路普产品图片库测试版

## 启动

如果 PowerShell 提示 `node` 无法识别，说明 Node.js 没有加入当前终端的 PATH。当前环境中 `node` 是一个依赖 `mise` 的 shim，而独立的 mise 运行器不可用，因此不要使用 `E:\CherryStudio\Toolchain\mise\shims\node.exe`。本测试版可以直接使用已安装的 Bun：

```powershell
cd "E:\CherryStudio\Data\Agents\system\2026-10-11\dc709edf-4325-4eae-8ea9-3f1eafc489a0\product-image-search"

& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/build-catalog.mjs
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/validate-catalog.mjs
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" server.js
```

看到 `产品图片库已启动：http://127.0.0.1:5173` 后，打开 `http://127.0.0.1:5173`。

如果希望当前 PowerShell 窗口临时支持 `bun` 命令，可先执行：

```powershell
$env:Path = "C:\Users\Administrator\.cherrystudio\bin;$env:Path"
bun --version
```

也可以将 Bun 路径加入 Windows 的用户或系统 PATH。

### 推荐：使用部署准备脚本启动（start-server.ps1）

部署/日常启动推荐使用 `scripts/start-server.ps1`（自动解析 Bun、默认只绑定回环地址、绝不打印密钥）：

```powershell
& scripts/start-server.ps1                              # 默认 127.0.0.1:5173
& scripts/start-server.ps1 -Port 8080                   # 仅改端口
& scripts/start-server.ps1 -Port 8080 -ListenHost 0.0.0.0 -AdminToken "…" -InternalPassword "…"
```

配置项（参数优先，其次环境变量，最后默认值）：

| 配置项 | 参数 | 环境变量 | 默认值 |
| --- | --- | --- | --- |
| 端口 | `-Port` | `PORT` | `5173` |
| 监听地址 | `-ListenHost` | `HOST` | `127.0.0.1`（仅回环，默认不暴露网络） |
| 管理令牌 | `-AdminToken` | `ADMIN_TOKEN` | 未提供时读取 `data/.admin-token`，再没有则首次启动自动生成 |
| 内部密码 | `-InternalPassword` | `INTERNAL_PASSWORD` | 未提供时使用服务器默认密码（仅测试用，生产部署务必显式设置） |

Bun 解析顺序：`-BunPath` 参数 → PATH 中的 `bun` → 已安装的 `C:\Users\Administrator\.cherrystudio\bin\bun.exe`。脚本只打印监听地址与各配置项「是否已提供」的布尔提示，**绝不打印 `ADMIN_TOKEN` / `INTERNAL_PASSWORD` 的明文内容**；监听地址不是回环地址时给出网络暴露提醒（配合 VPN/零信任与防火墙策略，切勿直接暴露公网）。也可通过 `npm run start-server`（或 `bun run start-server`）调用。

## 客户展示模式

当前服务已经生成并使用 `data/catalog.public.json` 作为浏览器目录。该公开目录只包含 `displayStatus=public` 的产品，且只含产品展示所需的型号、颜色、材质、尺寸、容量、重量、卖点和图片索引，以及**已批准英文字段** `en`（见「客户展示英文翻译」），不包含批发价、内部备注、箱规或装箱数量，也不包含审批字段 `displayStatus`/`displayReason`；分类统一为**规范分类**（见「分类归一」），不含原始分类/分类状态/分类原因等内部字段。构建脚本的保守默认初始状态为 0 款待审核；实际公开与否以 `displayStatus` 为准，当前实测环境经 `data/admin-store.json` 覆盖后已有 BL002 / LP2135 / LP2136 / LP2145 四款公开。内部完整数据仍保留在 `data/catalog.json` 和 `data/product-specs.json`，仅用于生成和校验。

### 客户展示英文翻译（Phase 2）

客户展示模式的英文 / 双语界面现在可以展示**产品资料英文翻译**（品名、分类、品牌、材质、尺寸、容量、重量、卖点、颜色、视角），全部来自**人工维护的翻译模型** `data/translations.json`，**绝不机翻**：

- **固定枚举词汇表 `vocab`**：视角（正面→Front）、分类（双肩背包→Backpack）、品牌（路普→LUOPU）、颜色（黑色→Black）等 hand-curated 词汇，构建时自动并入公开目录。
- **产品级翻译 `products`**：为当前 4 款公开产品（BL002 / LP2136 / LP2135 / LP2145）提供了完整英文品名 / 材质 / 尺寸 / 容量 / 重量 / 卖点 / 分类 / 品牌。
- **构建合并**：`scripts/build-catalog.mjs` 读取翻译模型，为公开目录每个产品生成 `en` 块（产品级翻译优先，其次词汇表），并在公开目录顶层输出 `viewLabels`。**内部目录（catalog.json）不携带 `en`**——内部查询模式与管理页固定中文。
- **安全回落**：客户界面英文 / 双语模式下，无英文翻译的产品字段安全回落到中文原文；筛选面板 / 芯片 / 卡片 / 图库 / 表格 / 相似检索全部随语言重绘；英文关键词（如 “Backpack”）也并入前后端检索。
- **内部模式与管理页固定中文**：进入内部查询模式后语言开关隐藏、产品资料一律中文原文；`/admin` 页面固定中文不变。

## 全量目录导入（知识库）

目录数据来自公司知识库《20-产品与技术/05-产品目录与报价》01-08 共 8 张报价表，共解析出 410 款产品：

- 01-步狼（白牌）186 款　02-定制尾单（清仓款）23 款　03-路普（自有品牌）50 款　04-路普（定制款）28 款
- 05-黑鹰（高品）17 款　06-威丽诗（女包现货）10 款　07-格朗奴（男包）3 款　08-外购产品登记表 93 款

数据流如下：

1. `data/product-catalog-source.json`：知识库报价表解析后的全量数据源，保留每行的原始字段（批发价、采购价、内部备注、箱规/装箱数量/装箱重量、MOQ、尺码表、上市/回货时间、来源文档与行号等）。由共享工作区 `tmp/parse-kb-catalog.mjs` 一次性生成；知识库报价表更新后，用该脚本重新生成即可。
2. `scripts/build-catalog.mjs`：读取数据源生成两份目录——
   - `data/catalog.json`：内部完整目录，含批发/零售/线上价格、内部备注、物流装箱字段、来源信息。
   - `data/catalog.public.json`：客户展示目录，只含 `displayStatus=public` 的产品，且只含型号、品名、分类、品牌、材质、尺寸、容量、重量、卖点、颜色、上市时间、图片索引和**已批准英文字段 `en` / `viewLabels`**（来自 `data/translations.json`，见「客户展示英文翻译」）；批发价、零售价、采购价、内部备注、MOQ、箱规/装箱数量/装箱重量、尺码表、来源信息以及审批字段（`displayStatus`/`displayReason`）一律剥离。非 public 型号的图片不进入公开目录。
3. `scripts/validate-catalog.mjs`：校验图片规格与完整性、型号唯一性、图片型号允许部分完整（0/4–4/4）、无伪造图片（无图型号不得携带视图数据）、display 审核状态（合法状态 `public`/`internal`/`pending`/`hidden` + 必须带审核原因）、**分类归一**（每款带 `category` 规范分类与 `categoryRaw`/`categoryStatus`/`categoryReason` 三件套，无遗留原始分类值，待确认分类必须出现在 `data/category-review.json`）、公开目录只含 public 产品且不含内部/审批/分类三件套字段、管理端新增槽位注册表与目录/文件一致、翻译模型（`translations.json`）字段与引用合法、公开目录 `en` 块只含已批准字段（不含任何内部字段）且内部目录不携带 `en`，并输出公开产品英文翻译覆盖率。

### 分类归一（Category Normalization）

数据源里的原始分类参差不齐（如「双肩包 / 双肩背包」「挎包 / 手提包 / 挎包/手提包」「腰包/挎包 / 腿包/腰包」并存、空分类、少量医疗/配件类命名不一致）。构建脚本通过 `scripts/category-normalize.mjs` 把它们归一到**规范分类**，供公开目录 / 筛选 / 翻译词汇表统一使用：

- **用户批准的归类规则**（按此精确执行）：
  - `双肩包`→`双肩背包`
  - `腰包/挎包` + `腿包/腰包`→`腰包/腿包`
  - `挎包` / `手提包` / `挎包/手提包`→`挎包/手提包`；品名显式含「单肩 / 斜挎」的同样归入 `挎包/手提包`
  - `其他配件`→`配件`；`枪套` / `弹夹带` / `腰带` / `背带` / `枪绳` / `扣具`→`配件`
  - 品名/分类含「医疗 / 急救 / 医护」→`附件包`（仅按品名/分类判定，描述里提及医疗用途不算，避免把背心等误归）
  - 保留 `水袋包` / `水壶包` 及各背心类（`战术背心` / `战术背心 组合套装` / `狗背心`）、服装 / 装备类分类
- **空分类自动归类**：先按「同系列基型」推导（如 `BL008C` 继承 `BL008`、`BL094-2` 继承 `BL094`、`HY8280-2` 继承 `HY8280`），再按品名/描述关键词高置信归类（背包/登山包→双肩背包，胸包→胸包/挎包，腰包→腰包/腿包，钓鱼/枪包→钓鱼包/枪包，套服/帽/手套等）。
- **待人工确认**：无法高置信归类的空分类标为 `category='待确认'`、`categoryStatus='pending'`，并写入 **`data/category-review.json`**（含 `model` / `name` / `source` / `row` / `evidence` / `candidates`），供下一步人工复核后直接在数据源行上补填分类或走管理端分类覆盖。
- **内部目录保留三件套**：`catalog.json` 每款带 `categoryRaw`（原始分类）/ `categoryStatus`（`approved` 批准规则 / `auto` 自动归类 / `pending` 待确认 / `admin` 管理端覆盖）/ `categoryReason`（归类原因/证据）；`category` 始终为规范分类。管理端在编辑弹窗中覆盖分类后，构建时标注为 `admin`。
- **公开目录只暴露规范分类**：`catalog.public.json` 只带 `category`（规范分类），**绝不携带** `categoryRaw` / `categoryStatus` / `categoryReason`。客户筛选与检索自动按规范分类工作。
- **翻译词汇表**：`data/translations.json` 的 `vocab.categories` 以规范分类为键（新增 `腰包/腿包`、`挎包/手提包`、`待确认` 等规范标签），构建时公开目录 `en.category` 只从规范分类查找翻译。

展示审核状态：
- 内部目录每个产品带 `displayStatus`（`public`/`internal`/`pending`/`hidden`）和内部原因 `displayReason`，由 `scripts/build-catalog.mjs` 依据数据源计算。
- 阶段一保守初始状态：LP2135 / LP2136 / LP2145（已有真实产品图）为 `pending`（待审核）；其余 407 款默认 `internal`，原因按来源系列生成（如“来源系列：01-步狼（白牌）（内部未公开，待审核后公开）”）。
- 后续阶段把某型号设为公开时，可在数据源行上声明 `displayStatus: "public"`（并附 `displayReason`）后重新生成；构建脚本优先采用数据源声明的状态。
- 管理端写接口（第一步）写入 `data/admin-store.json` 的覆盖优先级最高：其中某型号声明的字段覆盖与 `displayStatus`/`displayReason` 会在每次构建时覆盖数据源默认值，写入后自动重建并热更新公开目录。

图片型号映射保持不变：LP2136 / LP2135 / LP2145 三个型号有真实产品图（`data/product-specs.json` 为其权威数据来源），其余型号一律不生成图片占位——变体 `views` 为空对象、`complete=false`。管理端可在「产品资料 → 编辑」中为任意既有型号**新增颜色**（增量叠加在基础颜色之上），并为缺失视角**上传/替换/删除图片**（删除自动备份）；允许部分完整 0/4–4/4，未上传视角不会产生虚假图片。

每次图片或产品资料更新后先重新生成目录：

```powershell
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/build-catalog.mjs
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/validate-catalog.mjs
```

页面面向客户浏览：点击产品卡片进入统一图库，点击颜色即可切换颜色，主图支持缩略图、左右箭头和左右滑动切换四个视角。服务当前仍默认绑定 `127.0.0.1`；如需公司内多设备访问，应使用 VPN/零信任网络和认证，不要直接把端口暴露到公网。



- LP2136：4 个颜色 × 4 个视角
- LP2135：3 个颜色 × 4 个视角
- LP2145：3 个颜色 × 4 个视角
- 合计 40 张 JPG，统一为 1200×1500（4:5）；管理端可新增颜色并上传/删除槽位（不设固定张数上限，允许部分完整 0/4–4/4）
- 产品资料来自公司知识库《路普（自有品牌）产品报价表（2026）》

原始图片来自 `G:\Desktop\图片库素材`，已复制到 `data/images`；原始目录不会被程序修改。

## 功能

- 型号、颜色、视角、关键词筛选
- 同一页面客户展示 / 内部查询模式切换（内部模式需密码登录，见「同一页面：客户展示 / 内部查询模式」）
- 产品/颜色/视角详情弹窗
- 四视角完整性标记
- 统一 4:5 图片显示
- 以图搜图：浏览器端颜色直方图 + dHash 粗粒度相似检索
- 受白名单保护的图片 API，不暴露物理路径
- 客户界面中文 / English / 双语切换（仅客户展示模式；内部查询与管理页固定中文）；英文/双语界面同时翻译**固定 UI 文案**与**已批准产品资料英文字段**（`data/translations.json`，绝不机翻），无翻译字段安全回落到中文原文
- 移动端适配：筛选悬浮工具栏 + 底部抽屉，图库点击后主图 4:5 优先展示

## API

- `GET /api/health`
- `GET /api/catalog`
- `GET /api/products?q=&model=&color=&view=`
- `GET /api/image/{图片文件名}`

公开接口行为不变：公开目录携带已批准英文字段 `en` 与 `viewLabels`（仅客户展示使用）；`/api/products` 的 `q` 检索同时覆盖中文与英文产品字段。

## 管理/内部 API

鉴权边界：

- `/api/admin/*`：仅接受管理令牌（除 `GET /api/admin/auth-check` 外，该接口免鉴权，用于探测当前令牌是否有效）。
- `/api/internal/*`：接受**管理令牌或有效内部只读会话**（除 `POST /api/internal/login`、`GET /api/internal/session` 外）；内部会话无权访问 `/api/admin/*`。内部只读登录/会话见下一节。

管理令牌：

- 令牌来源：环境变量 `ADMIN_TOKEN`；未设置时读取 `data/.admin-token`；两者都没有时首次启动自动生成并写入 `data/.admin-token`（令牌不会出现在日志与审计中）。
- 认证方式：`Authorization: Bearer <令牌>`，服务端用 SHA-256 摘要做计时安全比较。

```powershell
$env:ADMIN_TOKEN = "..."   # 或直接使用 data/.admin-token 内容
Invoke-RestMethod -Uri "http://127.0.0.1:5173/api/admin/auth-check" -Headers @{ Authorization = "Bearer $env:ADMIN_TOKEN" }
```

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/admin/auth-check` | 免鉴权，返回 `{ authenticated: true/false }`，用于探测当前令牌是否有效 |
| `GET /api/internal/catalog` | 返回内部完整目录（含批发/零售价、内部备注、箱规、审核状态） |
| `GET /api/internal/image/{文件}` | 返回内部目录中既有图片文件（需令牌；管理页缩略图使用） |
| `GET /api/admin/products/{model}` | 返回某型号内部数据与当前 admin-store 覆盖 |
| `PUT /api/admin/products/{model}` | 更新白名单字段，请求体 `{ "fields": { ... } }` |
| `POST /api/admin/products/{model}/status` | 设置审核状态，请求体 `{ "displayStatus": "public", "displayReason": "..." }` |
| `POST /api/admin/products/{model}/colors` | 新增颜色（增量叠加在基础颜色之上），请求体 `{ "colors": ["红色", ...] }` |
| `DELETE /api/admin/products/{model}/colors?color=…` | 移除新增颜色（该颜色已有图片时返回 `409`，须先删除图片） |
| `POST /api/admin/images/upload?model=…&color=…&view=…` | 替换既有图片槽位或新增缺失槽位（原始 JPEG 请求体，见下；新增槽位仅当颜色已存在时允许） |
| `DELETE /api/admin/images/remove?model=…&color=…&view=…` | 删除图片槽位（备份原图到 images-backup，审计留痕） |
| `GET /api/admin/audit?limit=…` | 返回审计记录（默认最近 200 条，最多 500 条） |
| `POST /api/admin/rebuild` | 手动触发重建（重建后热更新内部与公开目录） |
| `GET /api/admin/workbench` | 图片补充/审核工作台只读统计：每产品/每颜色 0/4–4/4 完整度、系列（来源）、展示状态、**分类 / 分类状态（`category`/`categoryStatus`）/ 审核原因（`displayReason`）/ 是否覆盖（`statusOverridden`）/ 图片完整（`imageComplete`）/ 审核就绪度（`readiness`）**，以及全局汇总 `totals`（含 **`readinessCounts`** 按就绪度计数、**`byCategory`** 按分类计数；前端基于此渲染筛选、徽标与进度） |
| `GET /api/admin/backup/{文件}` | 安全读取 `data/images-backup` 下的既有 JPEG 备份（严格校验文件名：仅允许合法备份文件名、拒绝目录穿越/非 JPEG；批量撤销/还原用） |
| `GET /api/admin/translations` | 返回完整翻译模型 `translations.json`（词汇表 + 产品级翻译） |
| `PUT /api/admin/translations/{model}` | 更新某型号英文翻译，请求体 `{ "translations": { name, category, brand, materials, dimensions, capacity, weight, sellingPoints, colors } }`（字段值传 `null` 或空表示清除该字段翻译） |
| `DELETE /api/admin/translations/{model}` | 清空某型号的全部英文翻译（公开目录回落到词汇表翻译/中文原文） |

- PUT 白名单字段：`name`、`category`、`brand`、`materials`、`dimensions`、`capacity`、`weight`、`sellingPoints`、`launchDate`。传 `null` 或空字符串表示清除该字段覆盖。
- 翻译覆盖（`PUT/DELETE /api/admin/translations/{model}`）服务端校验：字符串字段非空、长度 ≤2000 且不含 HTML/控制字符；`sellingPoints` 为非空字符串数组（≤20 条，每条 ≤500 字符）；`colors` 的键必须是该型号颜色列表中的颜色（英文 ≤200 字符）。字段传 `null`/空清除该字段翻译；型号不存在返回 `404`。每次翻译写入与清空都会追加审计条目（`translate` / `translate-clear`）并重建目录。
- POST 状态接口加固：`displayStatus` 为 `null` 表示清除审核状态覆盖（回落到数据源默认状态与原因）；设置为 `public` 或 `hidden` 时必须提供非空的 `displayReason`。
- 每次 PUT/状态修改会把覆盖写入 `data/admin-store.json`（原子写入，上一版自动备份为 `admin-store.json.bak`），随后在进程内重建目录并热更新，无需重启。
- 所有写操作都会追加审计条目到 `admin-store.json` 的 `audit` 数组（动作、型号、变更前后），令牌本身不入审计。

### 内部只读登录/会话（Step 1）

`/api/internal/*` 接受两种凭证之一：管理 Bearer 令牌，或通过密码登录得到的内部只读会话。

- 内部模式密码默认是 `huang123456`；
- 会话：登录成功返回内存会话令牌 `token` 与 `expiresAt`（默认 8 小时，可用 `INTERNAL_SESSION_TTL_MS` 覆盖）；令牌只保存在进程内存，进程重启即失效。
- 会话令牌通过 `Authorization: Bearer <token>` 传递；内部接口接受管理 Bearer 或有效内部会话，但**内部会话无权访问 `/api/admin/*`**（管理接口仍只认管理令牌）。
- 暴力破解限流：连续 5 次密码错误后临时锁定登录（上限可用 `INTERNAL_LOGIN_FAIL_LIMIT` 覆盖），锁定期内一律返回 `429`，默认锁 60 秒（`INTERNAL_LOGIN_LOCK_MS`）。密码与令牌不写入日志、不入审计。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/internal/login` | 请求体 `{ "password": "..." }`；成功返回 `{ ok, token, expiresAt }`；密码错误 `401`；连续失败达上限后临时 `429` |
| `GET /api/internal/session` | 免鉴权探测会话状态：无/无效凭证返回 `{ authenticated: false }`；有效内部会话返回 `{ authenticated: true, source: "internal", expiresAt }`；管理 Bearer 返回 `{ authenticated: true, source: "admin" }` |
| `POST /api/internal/logout` | 使当前内部会话失效（管理 Bearer 无会话可失效，也返回成功）；未认证 `401` |

```powershell
# 登录（默认密码示例）
$body = @{ password = "huang123456" } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:5173/api/internal/login" -ContentType "application/json" -Body $body
Invoke-RestMethod -Uri "http://127.0.0.1:5173/api/internal/catalog" -Headers @{ Authorization = "Bearer $($login.token)" }
```

### 同一页面：客户展示 / 内部查询模式（Step 2）

`/` 首页顶栏新增 `[客户展示] [内部查询]` 模式切换，两个模式共用同一套筛选 / 网格 / 图库：

- **客户展示模式（默认）**：与之前完全一致——只加载公开目录、只显示 `displayStatus=public` 的产品，页面输出不出现任何内部字段，公开接口行为不变。
- **内部查询模式**：点击「内部查询」时弹出密码框，调用 `POST /api/internal/login`（密码对应 `INTERNAL_PASSWORD`，默认 `huang123456`）。登录成功后会话令牌只保存在当前标签页 `sessionStorage`（键 `internalToken`）；页面刷新后通过 `GET /api/internal/session` 探测会话并自动恢复内部模式；会话失效（401）时自动回到客户模式并弹出重新登录。内部模式加载 `GET /api/internal/catalog` 展示全量 410 款产品。
- **内部业务字段**：内部模式下产品卡片与图库弹窗额外显示内部字段——批发价、零售价、线上价、MOQ、箱规尺寸 / 装箱数量 / 装箱重量、来源系列、内部备注、审核状态 / 原因；全部经 HTML 转义，且仅在 `state.mode === 'internal'` 时渲染。客户模式下这些字段完全不输出（公开 UI 保持不变）。
- **退出**：点击「退出内部」调用 `POST /api/internal/logout` 使当前会话失效，并清空 `sessionStorage` 令牌、回到客户模式。
- **安全边界**：密码与令牌不进入前端 HTML / JS / CSS；内部数据只通过受保护的 `/api/internal/*` 接口获取，公开接口不泄露内部字段。

### 客户界面双语与移动端适配（Step 4）

**客户界面语言切换（中文 / English / 双语）**：

- 客户展示模式（默认）顶栏与移动端悬浮工具栏提供语言切换：`中文` / `EN` / `中/EN`（双语）。选择保存在 `localStorage`（键 `langPref`），刷新后保持。
- 翻译分两层：固定 UI 文案与枚举走前端统一翻译字典 `I18N`（`public/app.js` 内）；**产品资料**走公开目录的**已批准英文字段 `en`**（构建时由 `data/translations.json` 生成，hand-curated，绝不机翻）——品名、分类、品牌、材质、尺寸、容量、重量、卖点、颜色、视角在英文/双语模式下显示英文（缺失时安全回落到中文原文），内部目录与管理页固定中文。
- **内部查询模式与管理页固定中文**：进入内部模式后语言开关隐藏，全部文案回落到中文；`/admin` 页面保持中文不变。公开目录与接口行为不受影响。
- 双语模式显示「中文 / English」并列；图库、卡片、筛选选项、表格等全部随语言即时重绘。

**移动端（≤760px）**：

- 侧栏筛选默认隐藏；底部出现**紧凑悬浮工具栏**，包含：搜索框、结果数、语言切换按钮、筛选按钮（带当前生效筛选数量角标）。桌面端「隐藏筛选」按钮与顶栏语言开关在移动端隐藏，避免重复。
- 点击「筛选」打开**底部抽屉/浮层**（遮罩 + 面板从底部滑入），内含全部筛选（含客户筛选；内部模式下高级筛选一并放入抽屉，但依然登录受限，未登录不渲染）。抽屉提供「清除筛选」与「应用」按钮、关闭按钮，打开时页面滚动锁定（`body.drawer-open{overflow:hidden}`），Esc 或点击遮罩关闭。
- 图库弹窗在移动端调整：点击产品后先展示**大图主图（4:5）**，缩略图在下方，颜色与产品信息再往下排布；左右箭头与左右滑动切换视角保持可用；桌面端图库布局不变。

### 图片上传/删除（POST /api/admin/images/upload、DELETE /api/admin/images/remove）

后台的日常图片维护入口已整合到**产品编辑弹窗**（产品资料 → 编辑 → 颜色管理 / 产品图片）：缺失视角显示「上传」新增槽位，已有视角显示「替换」或「删除」（删除需确认，会自动备份原图）。

- 请求体为原始 JPEG 二进制（`Content-Type: image/jpeg`），最大 **20MB**；用 `model` / `color` / `view` 三个查询参数定位槽位。
- `upload` 同时支持**替换既有槽位**与**新增缺失槽位**：槽位已存在（型号/颜色/视角已在目录中）则沿用既有文件名原地替换并备份原图（响应 `created:false`）；槽位不存在且**颜色已存在**（基础颜色或管理端新增颜色）则新增槽位（响应 `created:true`）。若颜色不在该型号颜色列表中，一律返回 `409`（新增槽位前必须先新增颜色）；型号不存在返回 `404`；视角仅允许 `正面/45度/侧面/背面`。
- `remove` 删除既有槽位：先把原图备份到 `data/images-backup/<时间戳>_<原文件名>`，再删除文件；若该槽位由管理端新增，同步移除 admin-store 注册表条目。槽位不存在返回 `404`。
- 服务端校验：JPEG 魔数（`FF D8 FF`）与像素尺寸必须为 **1200×1500**，否则返回 `400`。
- 所有写入都用同目录临时文件原子落盘；重建目录失败时自动回滚（替换/删除恢复备份原图，新增删除文件与注册表条目）。Windows 下目标文件被短暂占用（图片流、杀毒扫描等）导致 rename 触发 `EPERM`/`EBUSY` 时，服务端有限次短退避重试（`renameWithRetry`），避免图片写流程偶发 500。
- 每次写操作都会写入审计记录：`image-upload`（替换）、`image-create`（新增）、`image-remove`（删除），含字节数、SHA-256 与备份文件名；颜色变更对应 `color-add` / `color-remove`。
- 示例：

```powershell
$token = (Get-Content "data/.admin-token").Trim()
# 新增颜色（增量叠加）
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:5173/api/admin/products/LP2136/colors" -Headers @{ Authorization = "Bearer $token" } -ContentType "application/json" -Body (@{ colors = @("红色") } | ConvertTo-Json)
# 为新增颜色上传缺失槽位
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:5173/api/admin/images/upload?model=LP2136&color=%E7%BA%A2%E8%89%B2&view=%E6%AD%A3%E9%9D%A2" `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "image/jpeg" } -InFile "new.jpg"
# 删除槽位（自动备份）
Invoke-RestMethod -Method Delete -Uri "http://127.0.0.1:5173/api/admin/images/remove?model=LP2136&color=%E7%BA%A2%E8%89%B2&view=%E6%AD%A3%E9%9D%A2" -Headers @{ Authorization = "Bearer $token" }
```

### 管理页面（/admin）

- 访问 `http://127.0.0.1:5173/admin`（仅页面壳，无敏感信息；令牌在页面内输入）。
- 令牌只保存在本次浏览器会话 `sessionStorage`，页面、脚本、样式均强制 `Cache-Control: no-store`。
- 登录后默认进入「产品资料」标签，共有五个标签页：
  - **产品资料（默认）**：读取 `GET /api/internal/catalog` 展示全部产品，支持按关键词 / 型号 / 分类 / 品牌 / 展示状态筛选，按型号 / 品名 / 分类 / 品牌 / 状态排序，并显示总数、筛选后数量与各状态计数。点击「编辑」打开编辑对话框，在一个产品内即可同时维护：
    - **基本资料**：仅编辑白名单展示字段（品名、分类、品牌、材质、尺寸、容量、重量、卖点、上市时间）；字段被覆盖时显示「已覆盖」标记与「清除覆盖」按钮；留空保存等同于清除该字段覆盖。未修改的字段不会提交，避免产生与基准值相同的无意义覆盖。
    - **展示审核状态**：下拉框可设置为 `public` / `internal` / `pending` / `hidden`（`public` 与 `hidden` 必须填写非空审核原因，客户端与服务端双重校验），或选择「清除覆盖」回落到数据源默认状态与原因。
    - **英文翻译**：编辑该型号的**已批准英文字段**（品名/分类/品牌/材质/尺寸/容量/重量/卖点 + 每个颜色的英文，均为手写翻译，绝不机翻）。留空保存表示清除该字段翻译；「清除翻译」清空该型号全部英文翻译。保存走 `PUT /api/admin/translations/{model}`（服务端校验非空、长度、无 HTML、颜色必须属于该型号），清空走 `DELETE /api/admin/translations/{model}`；未翻译字段在客户英文/双语界面安全回落到中文原文。固定枚举（分类/品牌/颜色/视角）已有全局词汇表兜底。
    - **颜色管理**：展示全部颜色（基础颜色带「基础」标记 + 管理端新增颜色带「×」移除按钮）。新增颜色为**增量叠加**（叠加在基础颜色之上，去重、保留顺序），支持一次输入多个（用顿号/逗号分隔）；新增后立即生成该颜色的新变体。移除新增颜色需确认；若该颜色已有图片则服务端返回 `409`（先删图再删颜色）。颜色名仅支持中英文/数字（长度≤24），不含空格与特殊字符——保证生成的文件名安全、可从文件名稳定映射回颜色。
    - **产品图片**：按颜色分组展示四视角槽位（正面 / 45度 / 侧面 / 背面），允许部分完整 0/4–4/4。已有图片显示受保护的内部缩略图（带缓存破坏参数），缺失视角显示「缺图」与「上传」按钮（可新增该槽位，颜色必须已存在）；无本地图片的产品显示「暂无已拍摄图片槽位」。每个已有槽位提供「替换」与「删除」按钮——点击上传后浏览器先做本地预检（类型 / 大小 / JPEG 标识 / 像素尺寸），通过后上传 `POST /api/admin/images/upload?model=&color=&view=`（服务端按槽位是否存在自动新增/替换）；「删除」需确认，走 `DELETE /api/admin/images/remove?model=&color=&view=`（自动备份原图到 images-backup）。操作成功后重新读取该产品并刷新弹窗缩略图，同时刷新产品列表与审计日志；失败时错误显示在当前图片区域，不关闭弹窗、不清空编辑内容。新增颜色/图片/删除不会改变 `displayStatus`，**不会自动公开**。
    - 保存后目录在进程内自动重建并热更新，产品列表、审计日志同步刷新。
  - **图片补充**：批量补齐产品四视角图片并辅助审核的工作台（详见「图片补充/审核工作台」与「审核就绪度」）。
  - **图片标准化**：浏览器本地图片标准化工具（详见「图片标准化（浏览器本地）」）——多选任意图片，逐张选择「填充裁切 / 完整适配」、拖动裁切区域（图像随指针移动）与缩放、箭头微调取景、自定义导出文件名，按统一 1200×1500（4:5）导出 JPEG；全部在浏览器内完成，不上传、不调接口、不写服务器。
  - **图片巡检（只读）**：展示既有拍照型号的全部图片槽位与每色完整度（如「4/4 视角」），提供「刷新」与「重新构建目录」；此页仅用于批量查看图片状态，不再提供替换入口（日常替换在产品编辑弹窗内完成）。
  - **审计日志**：展示最近写操作记录（动作、型号、说明）。

### 图片补充/审核工作台

「图片补充」标签页用于**批量补齐产品四视角图片并辅助审核**，全部复用既有管理接口（`colors` / `images/upload` / `images/remove` / `workbench` / `backup` / 既有状态接口 `POST /api/admin/products/{model}/status`），不新增任何写接口：

- **工作台统计**：顶部展示全局汇总（产品数、有图/无图、颜色组合、4/4 完整、部分完整、缺图、图片总数），来自只读接口 `GET /api/admin/workbench`；另有**审核就绪度计数**（就绪 / 待补图 / 待确认分类 / 待补图+分类）与**分类分布芯片**（点击芯片即可按分类筛选，再次点击取消）。
- **每产品 / 每颜色 0/4–4/4 进度**：每个产品卡片显示进度条（已拍张数 / 颜色组合 × 4）与「完整 / 部分 / 缺图」计数，并按颜色展示 `颜色 + 已拍/4` 芯片（4/4 绿、部分橙、缺图灰，悬停显示缺失视角）。
- **审核就绪徽标与分类徽标**：每款产品卡片在状态徽标旁展示**规范分类**（分类为 `pending` 时带「待确认」、为管理端覆盖时带「管理覆盖」标记）与**审核就绪度**（就绪绿 / 待补图橙 / 待确认分类蓝 / 待补图+分类红）；展示状态被管理端覆盖时带「已覆盖」标记；卡片底部展示**审核原因**（超长截断，悬停看全文）。
- **快速审核动作**：每款产品卡片提供 `公开` / `待审核` / `隐藏` / `清除覆盖` / `编辑` 按钮，全部复用既有状态接口（`POST /api/admin/products/{model}/status`）：`公开`/`隐藏` 会弹窗要求填写非空审核原因（预填当前原因，客户端 + 服务端双重校验），`待审核`/`内部` 保留已有原因，`清除覆盖` 回落到数据源默认状态与原因，`编辑` 直接打开该型号的产品编辑弹窗。每次操作后自动刷新工作台、产品列表与审计日志。
- **筛选**：按关键词（型号/品名/分类）、来源系列、展示状态、**分类**、**审核就绪度**、完整度（4/4 完整 / 部分完整 / 缺图）筛选。
- **批量上传**：多选或拖拽图片文件，客户端按文件名规范 `型号_颜色_视角.jpg`（如 `LP2136_黑色_正面.jpg`）自动解析型号 / 颜色 / 视角（可手动修正），在浏览器本地预检（JPEG 标识 + 尺寸 1200×1500 + ≤20MB，零依赖解析 SOF0）并预览缩略图。
- **批量新增颜色与上传**：开始后逐个处理——目标型号缺少该颜色时自动调用 `POST /api/admin/products/{model}/colors` 新增，再调用 `POST /api/admin/images/upload` 上传（新增缺失槽位或替换既有槽位，均由服务端判定）；队列显示每项进度与结果。
- **进度与自动回滚**：队列上方显示「成功 / 失败 / 已回滚 / 已撤销」与进度条。**上传中途失败时自动回滚**本批次已成功的条目（新增槽位删除、替换槽位读取备份原图重传还原），并移除本批次新增且已无图的颜色，保证目录回到批量前状态；配置/预检类失败仅标记该项，不触发整批回滚。
- **手动撤销**：全成功的批次会进入撤销栈，可在工具栏「撤销整批」或队列每行「撤销」回滚——新增槽位走 `DELETE /api/admin/images/remove`，替换槽位走安全备份读取 `GET /api/admin/backup/{文件}` 取回原图后重新上传。
- 安全：备份读取接口严格校验文件名（仅允许 `data/images-backup` 下的合法 JPEG 备份名，拒绝目录穿越/非 JPEG）；所有展示值均 HTML 转义；工作台只读统计不写数据，批量写操作继续走既有 API 的原子落盘与失败回滚。

### 图片标准化（浏览器本地）

「图片标准化」标签页提供**浏览器本地 Canvas 编辑器**，把非标准素材图统一成产品图规格，**不调用任何接口、不上传、不写服务器**：

- **多选加载**：点击或拖拽多张图片（JPEG / PNG / WebP，浏览器可解码即可），每张生成一张卡片与 4:5 缩略图预览；默认全选，可逐张勾选「导出」。
- **填充裁切 / 完整适配**：每张卡片可切换两种模式——「填充裁切（cover）」让图片铺满 1200×1500 画布并裁掉溢出部分（适合主体填满的画面）；「完整适配（fit）」把整张图等比放进画布、四周留白（适合需要完整展示的画面）。
- **拖动与缩放（图像随指针）**：填充裁切模式下可直接在缩略图上**拖动平移裁切区域**——拖动方向遵循**图像随指针移动**（指针向右/下拖 → 图像随之向右/下移动），边界自动钳制，拖动中把偏移写回为可见位置、保持偏移连续，不会越界或跳变；缩放滑杆 100%–300% 逐张微调取景。
- **箭头微调**：每张卡片提供 **▲◀▶▼ 四个微调按钮**（仅填充裁切模式可用），每次按裁切窗口尺寸的 5%（至少 4 源像素）精细平移取景，便于箭头逐档对齐主体。
- **导出文件名（可编辑）**：每张卡片提供「导出文件名」输入框（默认自动追加 `_1200x1500.jpg`），可手工改写；导出时自动**清理非法字符**（路径分隔符 / 控制字符 / `<>:"|?*` 等替换为 `_`）并**保证 `.jpg` 扩展名**（其它扩展名替换为 `.jpg`，空值回落到 `image.jpg`）。
- **对齐网格与中心十字**：每张预览叠加**三分构图网格**与**中心十字准线**辅助取景对齐；工具栏「网格：开/关」按钮可全局显示/隐藏（仅预览视觉辅助，不写入导出图）。
- **水平 / 垂直 / 居中 / 重置**：每张卡片提供对齐按钮——「水平」把裁切窗口对齐到图片横向中央、「垂直」纵向居中、「居中」横纵双向居中、「重置」回到左上角；切换「填充裁切 / 完整适配」时**保留裁切位置**（需要复位时用「重置」）。对齐按钮仅在填充裁切模式可用。
- **上一张 / 下一张与已处理进度**：工具栏提供「上一张 / 下一张」切换当前聚焦卡片（高亮边框并自动滚动到可视区，快捷键 **Alt+← / Alt+→**），工具栏实时显示「当前 / 总数」；每张卡片带「已处理」勾选框，拖动 / 缩放 / 模式 / 对齐 / 微调 / 改名 / 导出成功都会**自动标记已处理**，全局进度条显示「已处理 X / N 张」。
- **每张独立状态**：模式、缩放、裁切偏移、导出勾选、导出文件名、已处理标记全部**按卡片独立保存**，重绘 / 上一张下一张切换 / 网格开关都不会丢失；删除或清空才释放。
- **导出**：勾选要导出的卡片后点「导出所选（1200×1500 JPEG）」，浏览器逐张渲染 1200×1500 画布并下载 JPEG（文件名取各卡片「导出文件名」，自动清理非法字符并保证 `.jpg`）；**导出画布与预览取景完全一致（同一套 mode/scale/offset 计算），但不会把网格/十字画进导出图**；导出时状态栏显示逐张进度「正在导出 X/N」；导出质量滑杆（默认 85%，10%–100%）作用于全部导出。
- **纯前端实现**：`public/admin-standardize.js`（IIFE 包裹，不与 admin.js 顶层全局冲突；无 `fetch`、无 `/api/*`、无上传）+ `public/admin-standardize.css`；导出的图片需自行在「产品资料 → 编辑 → 产品图片」上传入库。既有管理页其它标签、上传/删除/翻译/工作台流程完全不受影响。

### 审核就绪度（review readiness）

就绪度是工作台对**图片补充 + 分类复核**两个维度的自动评估，由纯函数模块 `scripts/review-readiness.mjs` 计算（服务端 / CLI / 测试共用），**不参与客户展示，不写任何数据**：

- **图片完整度 `imageComplete`**：该型号所有颜色组合均为 4/4 四视角完整（颜色组合为 0 时视为未完整）。
- **分类状态 `needsCategory`**：`categoryStatus === 'pending'`（待人工确认分类）。
- **就绪分级 `readiness`**：
  - `ready`（就绪）：图片完整且分类已确认 → 可直接审核公开；
  - `needs-images`（待补图）：图片未完整（分类已确认）→ 优先补图；
  - `needs-category`（待确认分类）：图片完整但分类待确认 → 先确认分类；
  - `needs-both`（待补图+分类）：两者都未完成。
- 展示状态 `displayStatus` 不参与就绪分级（由工作台以独立徽标展示，便于快速切换审核动作）。命令行可运行 `npm run review-readiness` 直接查看全局就绪度与分类分布汇总。

### 集成测试

`scripts/test-upload.mjs` 会临时启动一个服务器实例（默认端口 5199，可用 `TEST_PORT` 覆盖，令牌用 `ADMIN_TOKEN` 或随机生成），覆盖成功替换、未认证、缺参数、新槽位 409、非 JPEG、尺寸不符、超限、审计与 `/admin` 路由等场景；结束后自动恢复原图、删除测试备份、还原 `admin-store.json` 与目录快照并重跑校验，不留测试产物。

```powershell
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/test-upload.mjs
```

`scripts/test-admin-products.mjs` 会临时启动一个服务器实例（默认端口 5200，可用 `TEST_PORT` 覆盖），覆盖产品详情、白名单字段编辑（含数组字段卖点）、非白名单字段 400、`null` 清除字段覆盖、审核状态校验（`public`/`hidden` 无原因返回 400、非法状态 400、`displayStatus:null` 清除覆盖并回落到数据源默认状态）、公开目录随之增删、审计记录，以及既有图片接口不受影响；结束后还原 `admin-store.json` 与目录快照并重跑校验，不留测试产物。

```powershell
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/test-admin-products.mjs
```

`scripts/test-admin-dialog.mjs` 会临时启动一个服务器实例（默认端口 5206，可用 `TEST_PORT` 覆盖），静态校验后台三件套（产品资料为默认标签、图片巡检只读标签、编辑弹窗内按颜色分组的四视角图片槽位与替换入口、复用既有上传端点 / 预检 / pendingSlot、脚本语法有效），并通过受保护 API 验证 LP2136 四颜色×四视角结构、驱动一次测试替换（检查审计与备份、替换后产品数据仍四视角完整）；结束后恢复原图、删除测试备份、还原 admin-store / 目录快照并重跑校验，不留测试产物。

```powershell
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/test-admin-dialog.mjs
```

`scripts/test-internal-login.mjs` 会临时启动两个服务器实例（默认端口 5201/5202，可用 `TEST_PORT` 覆盖），覆盖默认密码（`huang123456`）与环境变量 `INTERNAL_PASSWORD` 登录、`data/.internal-password` 只持久化 SHA-256 哈希且不含明文、会话可用与短 TTL 过期、登出失效、401/429 边界（内部会话不能访问 `/api/admin/*`）、公开路由回归、日志不泄令牌/密码；结束后还原快照、删除测试文件并重跑校验，不留测试产物。

```powershell
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/test-internal-login.mjs
```

`scripts/test-internal-mode.mjs` 会临时启动一个服务器实例（默认端口 5203，可用 `TEST_PORT` 覆盖），静态校验 public 三件套（模式切换标记、内部端点引用、内部字段仅在内部模式渲染、前端不含明文密码、脚本语法有效），并模拟前端完整调用链（公开目录不含内部字段、未认证 401、密码登录、内部目录 410 款含内部字段、会话探测、logout 后 401、公开接口回归）；结束后还原 admin-store / 目录 / `.internal-password` 快照并重跑校验，不留测试产物。

```powershell
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/test-internal-mode.mjs
```

`scripts/test-bilingual-mobile.mjs` 会临时启动一个服务器实例（默认端口 5205，可用 `TEST_PORT` 覆盖），静态校验 public 三件套（语言切换控件、`data-i18n` 静态翻译标记、移动端悬浮工具栏与底部抽屉结构、统一翻译字典 `I18N`、翻译仅客户模式生效、移动端图库主图 4:5、既有内部模式/高级筛选/鉴权标记回归、前端不含明文密码、脚本语法有效），并模拟前端调用链（公开目录不含内部字段、内部 401、密码登录、内部目录 410 款、公开接口回归）；结束后还原 admin-store / 目录 / `.internal-password` 快照并重跑校验，不留测试产物。

```powershell
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/test-bilingual-mobile.mjs
```

`scripts/test-images-add-remove.mjs` 会临时启动一个服务器实例（默认端口 5207，可用 `TEST_PORT` 覆盖），静态校验后台三件套（颜色编辑器、缺失视角上传按钮、既有槽位替换/删除按钮、删除接口引用、脚本语法有效），并通过受保护 API 覆盖颜色新增/移除（重复/基础颜色/非法名/空数组 400、型号不存在 404、已有图片时移除 409）、图片新增缺失槽位（颜色未存在 409、型号不存在 404、非法视角 400、非 JPEG/尺寸不符 400）、替换既有槽位（created=false + 备份）、删除槽位（备份 + 审计 + 目录移除）、部分完整度（0/4 → 1/4 → 2/4 均可通过校验）、公开目录只含 public 型号（内部型号新增颜色不自动公开、不进公开目录）、审计留痕；结束后删除测试文件与备份、还原 admin-store/目录快照并重跑校验，不留测试产物。

```powershell
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/test-images-add-remove.mjs
```

`scripts/test-translations.mjs` 会临时启动一个服务器实例（默认端口 5208，可用 `TEST_PORT` 覆盖），静态校验 public 三件套（产品翻译助手 `pTr/pEn/colorEn/viewEn`、`en`/`viewLabels` 读取、管理端英文翻译表单/接口标记、既有双语/内部模式标记回归、脚本语法有效），并模拟前端/管理端调用链：公开目录 4 款全部携带已批准英文字段 `en` 且英文展示字段完整、内部目录 410 款不含 `en`（内部固定中文）、翻译接口未认证 401 / 型号不存在 404 / 非法输入 400（空对象、非白名单字段、HTML、不存在的颜色、空卖点）、合法写入热更新公开目录、英文关键词 `Backpack` 前后端检索命中、置空清除单字段、DELETE 清空后安全回落到词汇表翻译/中文原文、审计留痕；结束后还原 translations/admin-store/目录快照并重跑校验，不留测试产物。

```powershell
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/test-translations.mjs
```

`scripts/test-workbench.mjs` 会临时启动一个服务器实例（默认端口 5209，可用 `TEST_PORT` 覆盖），静态校验后台三件套（图片补充标签、完整度/系列/状态/搜索筛选、每产品/每颜色 0/4–4/4 进度、批量文件选择器（多选/拖拽）、文件名解析 / 本地预检 / 预览、批量新增颜色与上传标记、进度与撤销/自动回滚标记、既有标签/编辑/翻译/审计标记回归、脚本语法有效），并对工作台纯函数做行为校验（`parseFileName` 按 `型号_颜色_视角.jpg` 解析、`readJpegDimensions` 解析 1200×1500 与非 JPEG 返回 null）；随后通过受保护 API 覆盖工作台统计（未认证 401、410 款产品、每产品每颜色完整度、与内部目录一致）、安全备份读取（未认证 401、目录穿越/反斜杠/非 JPEG/不存在 404、有效备份 200 且内容一致）、模拟批量「新增颜色 + 上传 → 回滚（删除槽位 + 移除颜色）」、替换槽位后「读取备份 → 重传还原」、审计留痕、`/admin` 路由回归；结束后删除测试文件与备份、还原 admin-store/目录/.internal-password 快照并重跑校验，不留测试产物。

```powershell
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/test-workbench.mjs
```

`scripts/test-review-workbench.mjs` 会临时启动一个服务器实例（默认端口 5211，可用 `TEST_PORT` 覆盖），静态校验后台三件套（分类/就绪度筛选、就绪度与分类分布统计、每产品分类/就绪度徽标与审核原因、快速审核动作按钮（公开/待审核/隐藏/清除覆盖/编辑，复用既有状态接口）、既有工作台标记回归、脚本语法有效），并行为校验 `scripts/review-readiness.mjs` 纯函数（`assessReadiness` 按 图片完整×分类状态 分级 ready / needs-images / needs-category / needs-both、零颜色组合视为未完整、`buildReadinessCounts` / `buildCategoryCounts` 计数正确）；随后通过受保护 API 覆盖工作台统计扩展（未认证 401、410 款产品、每款携带 `category`/`categoryStatus`/`displayReason`/`statusOverridden`/`imageComplete`/`readiness`、`totals.readinessCounts` 与 `byCategory` 求和等于产品数、就绪度与组合一致）、快速审核动作复用既有状态接口（public 无原因 400、设 pending 生效且覆盖标记为真、清除覆盖回落到数据源默认状态、公开后进入公开目录、清除后回落、审计留痕）、`/admin` 路由回归；结束后还原 admin-store/目录快照并重跑校验，不留测试产物。

```powershell
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/test-review-workbench.mjs
```

`scripts/test-standardize.mjs` 会临时启动一个服务器实例（默认端口 5212，可用 `TEST_PORT` 覆盖），静态校验后台扩展（图片标准化标签与面板控件（含网格显示开关、上一张/下一张、已处理进度、箭头微调、导出文件名输入框）、standardize 脚本/样式引用、既有 admin 标签/上传/编辑标记回归、package 脚本与 README 文档、admin-standardize.js 语法有效且不含 `fetch`/`/api/*`/上传调用），并对 admin-standardize.js 纯函数做行为校验（`clamp`、`baseScale` cover/fit、`computeCrop` 填充裁切偏移钳制与完整适配居中、`downloadName` 追加 `_1200x1500.jpg`、`alignOffset` 水平/垂直居中偏移、`drawStdGrid` 三分网格与中心十字可绘制、`moveOffset` 图随指针拖动方向、`nudgeOffset` 箭头微调增量与边界、`sanitizeFilename` 非法字符清理与 `.jpg` 扩展名保证），并校验导出画布不绘制网格（exportStdItem 不含 drawStdGrid 调用，导出与预览取景一致且不含网格）与导出文件名走可编辑的 `stdExportName`；随后通过服务器路由验证 `/admin` 返回含标准化的新管理页、`/static/admin-standardize.js|css` 可访问且内容正确、客户首页不引用 admin 资源；结束后仅杀服务器，不写任何数据文件，不留测试产物。

```powershell
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/test-standardize.mjs
```

`scripts/test-performance.mjs` 会临时启动一个服务器实例（默认端口 5213，可用 `TEST_PORT` 覆盖），对公开与内部端点做**延迟探针**：每端点 1 次预热 + `PERF_ITERATIONS` 次采样（默认 5），统计 min/avg/max/p95，断言全部成功且 avg < `PERF_MAX_AVG_MS`（默认 1000ms）、p95 < `PERF_MAX_P95_MS`（默认 2500ms）。内部探测先尝试默认密码登录——成功则用内部会话令牌探测 `/api/internal/*`，失败（已配置自定义 `INTERNAL_PASSWORD`）则回退为管理 Bearer 探测并记录跳过，兼容自定义密码环境。随后检查服务器日志不含管理令牌/密码/会话令牌、带 `ADMIN_TOKEN` 启动不改写 `data/.admin-token`；结束后还原 admin-store / 目录 / `.internal-password` / `.admin-token` 快照、杀服务器、清理残留临时文件、确认运行时文件与快照一致（无泄漏）并重跑校验。

```powershell
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/test-performance.mjs
```

`scripts/test-category-normalization.mjs` 会先跑一次构建，然后直接断言目录文件与待确认清单（内部目录每款携带 `category`/`categoryRaw`/`categoryStatus`/`categoryReason`、无遗留原始分类值、各批准规则与自动归类结果正确、待确认清单与 `data/category-review.json` 一致、公开目录只暴露规范分类且不含分类三件套），并 spawn 一个服务器实例（默认端口 5210，可用 `TEST_PORT` 覆盖）验证公开/内部接口字段隔离与工作台统计；结束后重跑校验，不留测试产物。

```powershell
& "C:\Users\Administrator\.cherrystudio\bin\bun.exe" scripts/test-category-normalization.mjs
```

## 安全说明

这是公司内部测试版。公开浏览接口当前不含登录，服务默认绑定 `127.0.0.1`（监听地址与端口可用 `HOST`/`PORT` 环境变量或 `start-server.ps1` 的 `-ListenHost`/`-Port` 配置）；管理/内部接口已用 Bearer 令牌保护（`ADMIN_TOKEN` 或 `data/.admin-token`），内部只读接口另可用密码登录（`INTERNAL_PASSWORD`，默认密码 `huang123456` 仅用于测试，生产部署务必设置 `INTERNAL_PASSWORD`）。如果部署到公司服务器并需要其他设备访问，应先通过 VPN/零信任网络，再为公开接口增加用户认证或共享令牌，不能直接把端口暴露到公网。客户展示模式和服务端向量检索属于后续阶段。

以图搜图第一版只在浏览器内临时处理用户上传的参考图，不上传、不保存。该算法适合当前同类产品素材的初步相似排序，不等同于 CLIP 等语义检索；后续需要识别任意客户照片时再升级检索模型。
