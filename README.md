# Bark 本地 MCP

标准 STDIO MCP，把 AI 客户端的工具调用转换为 Bark HTTP 请求。支持立即发送、定时发送、查看和取消提醒。采用官方 MCP SDK，支持 Node.js 22.21+ 或 24.5+，不需要编译。

## 安装

在项目目录执行 `npm ci` 安装依赖。首次配置时，复制 `.env.example` 为 `.env`，填写自己的 Bark 服务根地址和设备 Key。已有 `.env` 时请保留其中的配置，不要用示例覆盖。

`.env` 是本机明文配置文件，不是加密机制。不要提交或分享它。

## 接入客户端

在客户端选择 STDIO／本地命令，填写：

- 命令：`node`；客户端找不到 Node 时填写本机 Node 可执行文件的完整路径。
- 参数（两个独立参数）：`--use-env-proxy`、`/ABSOLUTE/PATH/TO/bark-local-mcp/src/server.mjs`，把占位路径替换成安装位置。
- 不必填写工作目录；配置按程序所在目录读取。

Codex 可使用 `clients/codex.toml` 中的配置表，替换占位路径后合并到现有 `~/.codex/config.toml`，不要覆盖整个配置文件。支持 `mcpServers` 配置格式的客户端可参考 `clients/mcp.json`；其他客户端按各自格式填写同一启动命令和参数。保存后重载 MCP 或重启客户端。

每个客户端自动启动自己的 MCP 接口进程，多个客户端复用同一套文件和提醒库。定时任务由单个共享 Node.js 后台执行，关闭 Codex 或其他 Agent 不影响已登记的提醒。后台没有 HTTP 监听端口，不用 Windows 任务计划程序。本机发送需要电脑开机、联网；迁移文件夹或换电脑后更新绝对路径。

启动参数 `--use-env-proxy` 让 Node 使用已有的 HTTP_PROXY、HTTPS_PROXY、NO_PROXY 环境配置；未配置代理时直接连接。Codex 配置里的 env_vars 用于转发这些环境变量，不保存代理地址或密码。其他客户端如果过滤子进程环境，也需要按其文档转发这些变量。参考 [Node 环境代理说明](https://nodejs.org/api/cli.html#--use-env-proxy)。

## 本机配置

服务地址和设备 Key 放在项目根目录的 `.env` 中，格式参考 `.env.example`。程序按自身位置读取 `.env`，不依赖客户端工作目录；不会把该文件的其他变量注入父进程。

提醒库 `data/reminders.sqlite` 保存消息、执行状态和创建任务时的连接配置快照（含设备 Key），也属于本机私密数据。这样修改默认配置不会把已安排的消息发给其他设备。示例只包含占位符；Git 忽略规则和 npm 打包规则均排除真实配置、提醒库、依赖和 work 目录。

| 环境变量／.env 项 | 含义 |
| --- | --- |
| `BARK_SERVER_URL` | Bark 服务根地址，支持自定义根路径，末尾不加设备 Key 或 `/push` |
| `BARK_DEVICE_KEY` | 固定接收设备的 Key；不会出现在工具参数或正常返回中 |
| `BARK_DEFAULT_GROUP` | 未指定分组时使用 `Codex`；可修改或设为空字符串 |
| `BARK_TIMEOUT_MS` | 请求超时，默认 10000 毫秒 |
| `BARK_DATA_DIR` | 可选，提醒库目录；默认使用项目下的 data 目录 |

配置优先级为：系统／客户端传入的环境变量 > `.env` > 旧版 `config.local.json` > 默认值。仍兼容旧版 JSON 配置；`config.example.json` 提供旧版字段示例。`BARK_ENV_FILE` 可指定另一份私有 .env 文件；`BARK_CONFIG_FILE` 可指定旧版 JSON 文件，建议使用绝对路径。凭据不必填进客户端的公开示例。

换电脑先安装 Node.js，再在项目目录执行 `npm ci`，自行填写 `.env`，最后配置客户端。所有网络请求要求 HTTPS；仅本机回环地址允许 HTTP，用于测试。网络代理继续由 Node 启动时的系统环境变量控制，不能只把代理变量写入本项目的 .env。

## 工具与通知规则

### send_notification

只在用户明确要求时使用，包括“这项任务完成后通知我”。仅仅完成任务、失败或需要处理，不构成发送授权。启动、列出工具、检查健康状态不会创建新的通知；启动时会恢复以前明确授权的待处理提醒，已到期且仍在补发窗口内的提醒可能随即执行。

`send_at` 不传或为 `null` 时立即发送；指定带时区的未来 ISO 时间时登记提醒并立即返回。示例：

```json
{
  "user_requested": true,
  "title": "喝水提醒",
  "body": "休息一下，喝点水。",
  "send_at": "2026-11-04T15:30:00+08:00"
}
```

“半小时后”由 Agent 根据当前时间换算成具体时间后调用。必须包含日期与时区，不接受没有时区的时间、过去时间或字符串 `"none"`，也不会把过去时间当作立即发送。Agent 应向用户显示实际安排的时间；返回值 `send_at` 使用 UTC（以 Z 结尾），UTC+8 显示时需要加 8 小时。任务用 `task_id` 标识，它与 Bark 自身用于替换通知的 `id` 不同。

`user_requested` 必须为 `true`；工具说明与服务器 instructions 均写入上述规则。这个参数是客户端对用户意图的声明，程序本身看不到完整聊天，不能独立验证用户授权。支持工具审批的客户端还可以为发送工具开启调用确认。

| 参数 | 类型与含义 |
| --- | --- |
| `user_requested` | 必填，只接受 `true` |
| `send_at` | 可选，null／不传为立即发送；带时区的未来 ISO 时间为定时发送 |
| `title` / `subtitle` / `body` | 标题、副标题、正文，支持中文与换行；至少提供一项内容或 markdown |
| `markdown` | Markdown 正文；提供后 Bark 忽略 body |
| `group` | 分组；未填使用本机配置 |
| `url` | 点击跳转链接，支持 HTTPS 与 iOS URL Scheme |
| `icon` / `image` | HTTP(S) 图标、图片地址 |
| `sound` | 铃声名称，如 minuet；不填由已部署服务决定 |
| `level` | active、passive、timeSensitive、critical；不默认使用强提醒 |
| `volume` | 0–10 整数；必须同时指定 level=critical |
| `call` | 布尔值；true 循环响铃 30 秒，只有用户明确要求重复响铃时才设置 |
| `badge` | 非负整数；0 也会清除通知中心中的 Bark 通知，谨慎设置 |
| `copy` | 用户选择复制时的内容 |
| `action` | alert 或 none；url 优先 |
| `isArchive` | 布尔值，是否保存历史；不填遵循 App 设置 |
| `ttl` | 可选正整数，历史记录保存有效期（秒），没有默认值，不是延迟发送 |
| `id` | 字符串通知标识；重复 ID 可替换通知 |

TTL 仅对保存的消息生效；明确设置 isArchive=false 时不能同时设置 TTL。到期后的移除由 Bark App 处理，不是 MCP 定时任务。本版固定一个接收设备，不提供批量推送、加密或删除通知功能。

内部使用 `POST /push` 和 JSON，请求体携带设备 Key，不把消息内容或 Key 拼进 URL。可选参数不填就不发送，尤其不设置默认 TTL、critical、重复响铃或归档策略。不同 Bark 服务端对未传 sound 的默认处理可能不同。另外，参考的 Worker 实现用真值判断处理 volume，可能忽略数值 0；MCP 会原样传递 0，但最终行为仍受上游实现限制。

立即发送返回 `accepted` 表示 Bark 接受请求，不代表手机已显示通知。定时发送初始返回 `pending`、任务 ID 和时间，表示已保存，不表示已经推送。超时或网络中断会返回／记录 `unknown`，不自动重试，避免重复推送。检查手机后再决定是否重发。`rejected` 表示 Bark 返回错误。

### list_scheduled_notifications

查看共用本项目提醒库的所有客户端创建的任务。`include_completed` 默认为 false，只显示 pending／sending；设为 true 时也显示 accepted、rejected、unknown、not_sent、cancelled、expired。`limit` 默认为 50，最大 100；`offset` 用于翻页。返回时间、内容、任务 ID 和结果，不返回设备 Key。`scheduler_running` 表示后台当前是否在运行。

### cancel_scheduled_notification

用户明确要求取消时，传 `task_id` 和 `user_requested: true`。只取消 pending 任务，重复取消安全。已进入 sending 或已结束的任务不能撤回，工具会明确返回当前状态。取消操作不会发送通知。

## 后台运行与恢复

- SQLite 持久化保存任务；多个客户端通过事务领取任务，共享一个后台进程。部分受支持的 Node.js 版本会把内置 SQLite 的实验功能提示输出到 stderr，不影响 MCP 协议。
- 后台约每秒检查到期任务，没有待发送消息时不发网络请求。它会占用一个 Node.js 进程，不为每条提醒另开进程。
- 关闭 Agent 后仍运行。电脑关机、睡眠或断网期间不能保证准时发送，也不会主动唤醒电脑。
- 恢复执行时，晚到不超过 30 分钟的待处理提醒可以补发；超过 30 分钟标记 expired。这个窗口与 ttl 无关。
- 已经尝试过的推送不自动重试。后台在 sending 阶段崩溃后，该任务标记 unknown；这可能牺牲一次提醒，但避免自动重复发送。
- 后台意外退出后，重新启动任一 MCP 客户端，或运行 scheduler:start，可恢复尚未发送的任务。文件持久化不等于进程始终存活。
- Windows 可用下面的脚本启用当前用户登录自启动；它使用用户启动项，不创建 Windows 定时任务，也不要求 Windows 密码。其他操作系统可用各自的进程管理器运行同一个 daemon.mjs。

登录启动项由用户运行下方 Enable 命令主动启用，安装依赖本身不会添加启动项。启用后可在重新登录时恢复后台；使用者应在自己的机器上验证登录启动行为。

```powershell
# 当前用户登录后自动恢复后台
powershell.exe -NoProfile -File scripts/windows-autostart.ps1 Enable
# 查看／移除本项目的登录启动项
powershell.exe -NoProfile -File scripts/windows-autostart.ps1 Status
powershell.exe -NoProfile -File scripts/windows-autostart.ps1 Disable

npm.cmd run scheduler:start
npm.cmd run scheduler:status
npm.cmd run scheduler:stop
```

迁移文件夹后要更新客户端配置与登录启动项；备份提醒库时先停止后台，并关闭相关客户端以避免数据库仍被使用。存储、后台执行和 MCP 接口分别放在 store.mjs、daemon.mjs、server.mjs，未来可更换云端的存储和触发机制。Cloudflare Workers 迁移仍需要其 Alarm 等运行适配，并非原样运行本地常驻进程。

### check_service

无参数，调用 `/healthz` 检查服务是否可达，不发送通知，不验证设备 Key 和手机接收情况。

## 验证

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run privacy:check
```

`test` 使用本机假服务和 work 下的隔离提醒库，验证 STDIO、参数、取消、多客户端、关闭客户端后继续执行、重启恢复与不重复发送；不会访问真实推送接口。`check` 通过 MCP 检查真实 `/healthz`，不会创建测试提醒。启动 MCP 时会恢复以前已获授权的待处理提醒。真实发送需要你明确要求后再验证。

## 发布与隐私

- 可以提交源码、测试、文档、锁文件，以及 `.env.example`／`config.example.json`。客户端示例中的安装路径是占位符，不包含作者的个人目录。
- 不要提交 `.env`、任何 `.env.*` 私有文件、`config.local.json`、`data/`、`work/`、数据库副本或日志。`.env.example` 是可公开的例外。
- `npm run privacy:check` 检查公开源码清单中的已知设备 Key、自用服务域名、本机路径和常见凭据特征，也检查 Git 当前是否跟踪了私有文件。报告只显示文件名与问题类别，不回显凭据。它不保证识别所有秘密，也不清理 Git 历史。
- `package.json` 的 files 清单限制 npm 打包范围，`.npmignore` 进一步排除本机数据。可用 `npm pack --dry-run --json` 查看打包清单；上传 GitHub 前仍需核对 `git status` 和暂存差异。
- `.gitignore` 和 `.npmignore` 不会自动过滤操作系统手工压缩的整个目录。不要把运行中的完整工作目录直接压缩上传。
- 即使配置通过环境变量传入，定时提醒库仍保存连接快照；备份数据库也可能包含消息与设备 Key。环境变量与 YAML／JSON 都不是加密。

## 参数依据

- [Bark 官网参数](https://bark.day.app/#/params)
- [Bark 官网请求格式](https://bark.day.app/#/tutorial)
- [所部署 Worker 的实现](https://github.com/cwxiaos/bark-worker/blob/master/main.js)
- [官方 MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp)
