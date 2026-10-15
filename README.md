# dsh-pylon-trae

> A **Trae LLM provider plugin for DeepSeek Harness (DSH)**.
> Repository: <https://github.com/rumilhz/dsh-pylon-trae>
> Package name: `dsh-pylon-trae` (this is the first plugin under the `dsh-pylon-` prefix).

---

## English

### What it is

This plugin adds a **Trae** provider to DeepSeek Harness. After installing it and
restarting DSH, `Settings → Models` gains one **editable** `Trae` provider whose
model list is read from the Trae installation already signed in on this machine
(Trae desktop app, or the Trae CLI).

It does **not** depend on, import, or patch `dsh-connect-trae`.

### How it works

1. It reads the credential file that the Trae desktop app or the Trae CLI already
   wrote, and decrypts it locally with its own implementation.
2. It pulls the live model directory for the signed-in edition (CN or
   international) and decodes the streaming responses.
3. It serves an OpenAI-compatible endpoint (`/healthz`, `/v1/models`,
   `/v1/chat/completions`) from a **fixed loopback port**.
4. It seeds one provider entry into the `llm-pi-ai` namespace, which is the
   namespace the Models page renders an editor for — so you can add, remove and
   test models from the UI.

**Trae's own data is read-only.** The plugin never writes to Trae's files; there
is an assertion in the code that refuses to.

### Hard prerequisites — all four

| # | Requirement | If it is missing |
| --- | --- | --- |
| 1 | **Trae is signed in on this machine** (desktop app is easiest; the CLI counts too) | The plugin starts but exposes no models and reports "no usable credential" |
| 2 | **Port 7864 is free** (CN build; 7865 for the international build) | The loopback service cannot start, which means there is no channel at all |
| 3 | **`dsh-connect-trae` is not mounted in the profile** | Two Trae providers fight over the same route id (`trae` / `trae-global`) |
| 4 | **Windows** | The macOS / Linux code paths exist but are **untested on real hardware** |

> Installing does **not** start or restart DSH. Quit DSH completely and reopen it.
> Reloading the window is not enough.

### Install

Three routes are documented in [`发布.md`](发布.md). In short:

- **From this repository (GitHub source).** The install target is a pnpm GitHub
  spec, `github:rumilhz/dsh-pylon-trae`. Any DSH version that can add a plugin
  from a GitHub source can install it this way.
- **From the plugin market.** ⛔ **Not searchable yet.** An entry has been / will
  be submitted to the curated `awesome-dsh-plugin` catalog, but the market only
  offers sources inside that catalog, so this route works **only after that pull
  request is merged**. See [`发布.md`](发布.md).
- **From a prebuilt tarball.** `node tools/pack.mjs` produces
  `dist/dsh-pylon-trae-<version>.tgz` plus a `.sha256` and a `.manifest.txt`
  checksum pair; `node install.mjs --from <tgz>` installs it offline.

Node **≥ 22.6** can run the `.ts` sources directly (type stripping), so there is
no build step.

---

## 中文

### 这是什么

**DSH 的 Trae 供应商插件**（自研实现；不依赖、不引用、不打补丁于 `dsh-connect-trae`）。

目标形态：在「设置 → 模型」里出现一条**可编辑**、含 Trae 全量模型、能自己筛的供应商。

- 包名 `dsh-pylon-trae`，仓库名 `dsh-pylon-trae`。
- 状态/数据目录只有一个：`$DSH_HOME\.dsh-pylon-trae\`（token、`state.json`、备份、`boot.log` 都在里面）。
  旧 `.dsh-trae\` 首次启动时会自动**复制**迁移，原目录保留给用户自己清理。

> **四硬前提**见上面英文小节的表格（Trae 已登录 · 7864 空闲 · profile 里没有 `dsh-connect-trae` · Windows）。
> 装完必须**完全退出 DSH 再打开**，刷新页面不算。

### 状态（截至 2026-10-14 深夜）

> **M1~M6 是什么**：不是版本号，是**施工顺序**（M = milestone）。
> 每一步都刻意做成"做完就能单独验证"的一小段，且**顺序保证越早可用**：
> M1 只读不碰配置 → M2 让链路能说话 → M3 才把它接进「设置 → 模型」→ M4 之后就都是加功能。
> **状态口径**：✅ = 本机实测通过 · ⏳ = 没做完，或做完但**还没验收**。

| 里程碑 | 一句话：这一步在干什么 | 做完你会看到什么 | 状态 |
|---|---|---|---|
| M0 | 先把别人的插件读透、把行号钉死、选路线 | 一份带行号的现状与选路文档 | ✅ |
| M1 | 只读：找到 Trae 的凭据并解开、把线上模型清单拉下来 | 一条命令打出「读到几个账号、线上有多少模型」 | ✅ 本机 CN 79 个模型（4 个接口全 200） |
| M2 | 让本插件自己的服务能"代替 Trae 说话"（固定端口 + 协议 + 流式解码） | 打自己的端口，能收到带工具调用的流式回复 | ✅ 文本/thinking/usage/`tool_calls` 全通 |
| M3 | 把这条供应商**写进「设置 → 模型」**（workbuddy 那种可编辑条目） | 模型页出现 Trae 一行，能勾选模型、保存、重启不丢 | ✅ **真冷启动通过**（79 模型写入；二次启动 no-op） |
| M4 | 服务端：插件自带端点 + 宿主路由 + 不开 UI 的 CLI | 没有浏览器也能读账号/目录/用量/签到/测试 | ✅ 端点两条前缀都在；`/models/reload`（只读重拉）与 `/models/refresh`（只增不删写配置）已分开 |
| 卡片 | 浏览器半边：设置卡片（账号/目录/「刷新目录」/「重建清单」/用量/签到/测试） | 设置 → 插件里出现 dsh-pylon-trae 卡片，按钮点得动 | ⏳ **代码已落地**；两个离线闸门全绿。仍差真人重启后点一次 |
| M5 | 功能对齐（用量积分 / 输入框读数 / 每日签到 / 一键测试 / 图片 / 推理档位） | 上游有的那些功能逐项出现 | ⏳ **已做**：推理档位映射、用量/签到/测试端点与卡片按钮。**未做**：输入框积分读数 + 账号浮层。**图片输入刻意不做**：协议层不翻译 `image_url`，于是目录也不宣告 `image`（理由写在 `src/protocol.ts` 顶部） |
| M6 | 收尾：把上游 `dsh-connect-trae` 从 profile 移除 | 选择器里只剩本插件那一条 Trae | ⏳ |

**验证全部跑在临时 profile 上**：`<工作区>\_trae-coldstart\home`（独立 `DSH_HOME`，里面**只**装本插件）。
把插件装进真 profile（`~/.dsh/profiles/*`）是**部署动作**。

### 怎么验（全部可复制）

把 `<node>` 换成你本机的 Node ≥ 22.6 可执行文件（DSH 自带的那份即可）：

```bat
set NODE=<node>
```

#### ① 服务端离线回归（不联网、不花额度）—— 当前 **10/10 套件 PASS**

```bat
%NODE% tools\_run-suites.mjs
```

任一失败即退出码非 0（缺脚本记 SKIP，**不算过**）。想单跑某一项（排查时更省时间，**退出码 0 才算过**）：

```bat
%NODE% tools\check-entry.ts        :: 入口能 import、Config 校验（本机：ENTRY OK）
%NODE% tools\test-seed.ts          :: 写路径 create/present/refresh/回滚 + 备份保留策略（真文件系统 e2e）
%NODE% tools\test-api.ts           :: 端点处理函数
%NODE% tools\test-reasoning.ts     :: 推理档位映射
%NODE% tools\client-bundle-check.mjs  :: 卡片 bundle
%NODE% tools\client-route-check.mjs   :: 宿主路由 handler，走真 HTTP
```

> `tools/test-seed.ts` 与 `client-*.mjs` **自己不打总数**（只打 `ALL CHECKS PASSED` / `N/N`），
> 所以判据始终是**退出码 0**，不是某一行的数字。

再加两项**联网只读**检查（只拉目录、只起回环服务，不产生生成、不花额度）：

```bat
%NODE% tools\_run-suites.mjs --network
```

#### ② 冷启动验收（起真 DSH 进程）—— 当前 **19/19**

```bat
%NODE% tools\coldstart-verify.mjs
```

它自己会：重建临时 profile → 起真 DSH（显式给 `DSH_HOME`）→ 轮询
`$DSH_HOME\.dsh-pylon-trae\boot.log` 与 profile patch → 断言 `seed: created` → 断言
`providers.trae` 与模型数 > 0 → 用 Bearer 打 `http://127.0.0.1:7864/admin/status` 得到 `ok:true`
→ 停进程 → **再起一次**断言 `seed: present` 且 patch sha256 未变 → 打印结论与耗时，并确认 7864 已释放。

```bat
%NODE% tools\coldstart-verify.mjs --keep-profile
%NODE% tools\coldstart-verify.mjs --skip-restart
%NODE% tools\coldstart-verify.mjs --capture
%NODE% tools\coldstart-verify.mjs --timeout 120 --port 7864 --dsh-profile unset
```

> **铁律不变**：脚本只写工作区下的 `_trae-coldstart\`（临时 `home\` 加上它自己的 PID 账本
> `coldstart-pids.json`、可选捕获日志），**不引用**活体 `~/.dsh`；启动的每个进程都记账，
> 结束前连子进程一起杀，并复查端口。它**能重复跑**。

#### ③ 真机六条用法（不需要 UI；只有 `test` 花一点点额度，`refresh` 可能写配置，其余只读）

```bat
%NODE% tools\trae.ts status
%NODE% tools\trae.ts models --limit 30
%NODE% tools\trae.ts usage
%NODE% tools\trae.ts checkin
%NODE% tools\trae.ts test --model mimo-v2.6-flash
%NODE% tools\trae.ts refresh --host
```

· `status` —— 账号（desktop + CLI）+ 模型数 + 当前凭据（只有 `sha256[0:12]` 指纹）
· `models --limit 30` —— 实时目录逐条列出：id / 名字 / 上下文 / 输入模态 / 所属 function
· `usage` —— 总额与各 pack 的 `credits_amount`（只读，不花额度）
· `checkin` —— 今日签到状态（只读）；**加 `--claim` 才真的领**，那会改变账号状态
· `test --model <id>` —— ⚠️ 会向 Trae 发一条极小真实消息，**消耗一点点额度**
· `refresh --host` —— 让**正在运行的宿主**重建清单（只增不删；需要 7864 上已经有宿主在跑）

#### ④ 客户端半边的两个离线闸门（不需要浏览器）

```bat
%NODE% tools\client-bundle-check.mjs
%NODE% tools\client-route-check.mjs
```

`client-bundle-check` 查：经典脚本可加载、席位注册、无任何凭据、四个状态都渲染，外加：
**「刷新目录」必须打到 `POST /models/reload`、「重建清单」必须打到 `POST /models/refresh`**（两者不许互换）、
reload 之后目录行里的 `模型 N 个` **只出现一次**、`accountWarning` 原样透传到卡片（红字）。
`client-route-check` 查：两条前缀路由、disposer 反注册、失败一律回 `{ok:false,detail}`，
以及**栅栏口径**——只有「Host 与 Origin 都是回环」的 403 被容忍（且只 trace 一次），
401 永不放过，非回环 Host/Origin 仍然 403。

这两个数字**会继续长**，所以只当"跑没跑过"的判据：**退出码 0 才算过**。

#### ⑤ M1 只读探针（原来的入口，仍然可用；不联网不花额度）

```bat
tools\probe-m1.cmd --no-network
```

去掉 `--no-network` 就是**再拉一次实时模型目录**（会联网，只读）。

### 已知限制（都会静默失败，所以写在这里）

**① 卡片这条通道依赖宿主的两件事，任一件变了卡片就整片 403。**

卡片的数据走宿主 web server 上本插件自己注册的路由（`/plugins/dsh-pylon-trae` 与 `/api/plugins/dsh-pylon-trae`），
而请求要过宿主自己的栅栏 `connection.requestRejection`。桌面 app 的 UI 层只转发 `/api/*`，
并且会把 Host 改写成宿主端口、Origin 仍是 app 端口 —— 于是同一个栅栏**对回环请求也回 403**。

我们的处理是**容忍这一种 403**（Host 与 Origin **都是回环**，端口可不同）：仅此情形放行并 trace 一次；
**401 绝不放行**，非回环 Host/Origin 仍然 403。

⇒ 若某天宿主改了这套判据，症状是卡片五个区块**全是**
`HTTP 403 … 没有返回 JSON（这条路没被转发到插件）`。**先看 `$DSH_HOME\.dsh-pylon-trae\boot.log` 里有没有这行**：

```
host route: fence 403 tolerated as a loopback port hop (host=… origin=…) — the card is served through the desktop app's proxy
```

有 ⇒ 栅栏已放行，问题在别处；没有 ⇒ 请求在栅栏处就被判掉了（`handleApi` 一次都没被调用）。
另一种"没数据"是插件根本没被 import：模块顶层会打 `[dsh-pylon-trae] module loaded`，
**没有这行 = 没被 import；有这行但没有 `apply:` 行 = import 了但 apply 没跑**（inject 依赖没到，插件停在 PENDING）。

**② 图片输入是刻意没开的，不是漏了。**

`src/protocol.ts` 顶部有 `NOT IMPLEMENTED — image input (deliberate)` 一节：请求侧**不翻译** `image_url`
内容块，所以目录里 `multimodal === true` 的模型也**不**往 provider 条目的 `input` 里写 `'image'`
（恒为 `['text']`）。理由是"先宣告、再让用户的图片静默消失"比不支持更糟。

**③ 单次「测试启用模型」最多 10 个，而且每个都是真请求。**

`/models/test` 的 `MAX_PROBE_MODELS = 10`（`src/api.ts`）：显式给 `modelIds` 时，去重、丢掉未知 id 之后
最多真的测 10 个，被截掉的用 `requested / tested / truncated` 明说；不给 `modelIds` 只测前 5 个。
每个 verdict 都是**一次真的发往 Trae 的请求**（30s 超时、串行），所以**这一步会花一点点额度**。
反过来，`/models/reload` 与 `/models/refresh` 只拉目录，不发消息、不花额度（`refresh` 会写配置）。

**④ 只在 Windows + Trae CN 上实测过。**

路径与 edition 表按三平台（win32/darwin/linux）写好，但 macOS / Linux **没有真机验证**；
国际版（`ai` 区域）同理 —— 本机没有国际版凭据，代码结构保留了 `cn/ai` 双桶，等有账号时再验。

### 目录结构

```
src/format.ts     ← 生成物（tools/extract-format.mjs）：Trae 自身格式常量（salt 表、storage key、directory functions）
src/paths.ts      ← 三个平台的安装/数据目录探测（4 个 edition，desktop + CLI）
src/auth.ts       ← 凭据读取与解密（自研实现）、账号归一化、CLI JWT 解析
src/identity.ts   ← 机器/设备身份（读 Trae 自己的文件，绝不伪造）
src/catalog.ts    ← 实时目录拉取（逐 function 取并集）+ 静态兜底 + 请求头契约 + 推理档位解析
src/protocol.ts   ← 请求翻译（OpenAI → Trae）+ 命名 SSE 解码（Trae → OpenAI chunk）
src/shim.ts       ← 固定端口回环门面：/healthz · /v1/models · /v1/chat/completions
                    以及 /admin/* 与 /plugins/dsh-pylon-trae/* 两条插件端点前缀，同一条 Bearer
src/seed.ts       ← 找 namespace、生成供应商条目、create / present / refresh（只增不删）
src/guard.ts      ← 写路径安全网：写前备份、写后由纯函数 judgePatchWrite 核对四条
                    （条目不少 / 文件不空 / provider 真在 providers 字典里 / 模型数等于期望）；
                    "读不到"判失败（"无法确认" ≠ "确认无误"），任一不过就逐字节回滚
src/api.ts        ← 端点处理函数（与传输无关，可离线测）；/models/reload（只读重拉）与
                    /models/refresh（只增不删写配置）是两条不同的路由
src/index.ts      ← 插件入口：配置 + 起服务 + 种子 + 账号状态/墓碑集合（落 .dsh-pylon-trae/state.json）
lib/client.js     ← 浏览器半边：设置卡片（两个席位；**不碰**回环 token，只走宿主路由）
tools/            ← 见上面「怎么验」；另有 make-temp-profile.mjs（临时 profile 配方）
cordis.patch.yml  ← 本插件的 bundle 补丁（声明它是怎么被 profile 挂上的）
install.mjs       ← 装机入口（源码目录 link / tgz --from / --uninstall / --rollback）
```

### 安全约定

```
· 探针只打印 token 的 sha256[0:12] 指纹；真实 token 只在内存里，且永不写入 cordis.patch.yml、日志或任何 HTTP 响应
  （写进供应商条目的是**本插件自己的回环 token**，不是 Trae 的凭据 —— 它只用来挡住别的本机进程蹭额度）
· 凭据值、token 值一律不打印；冷启动脚本比对 Authorization 时也只比 sha256 指纹
· 绝不碰活体 profile（~/.dsh）：所有验证都在工作区下的临时 home 里做
· 写文件一律用编辑工具或 Node 的 fs.writeFileSync(p, s, 'utf8') —— 不用 PowerShell 的 Set-Content / Out-File
· Trae 的数据只读：install.mjs / doctor.ts 里都有断言拦着写 AppData\Roaming\Trae*
```

### 许可

MIT，见 [`LICENSE`](LICENSE)。

`src/format.ts` 是由 `tools/extract-format.mjs` 生成的**格式常量**（Trae 自身 storage key 与 salt 表），
数据来源是同样以 MIT 分发的 `dsh-connect-trae@3.4.0`；本仓库没有 vendor 它的任何代码。
