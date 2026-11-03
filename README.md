# Bark 本地 MCP

让支持 MCP 的 AI 客户端通过 Bark 向手机发送通知，支持立即发送、定时提醒、查看和取消提醒。

使用本地 STDIO 连接，可供多个客户端共用。需要已有的 Bark 服务和设备 Key，以及 Node.js 22.21.x 或 24.5+。

## 1. 安装与配置

下载项目后，在项目目录执行：

```sh
npm ci
```

首次使用时，将 `.env.example` 复制为 `.env`，填写：

```dotenv
BARK_SERVER_URL=https://your-bark-server.example
BARK_DEVICE_KEY=YOUR_DEVICE_KEY
```

服务地址填根地址，不要附带设备 Key 或 `/push`。已有 `.env` 时无需重新复制。

其他配置均可选：

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `BARK_DEFAULT_GROUP` | `Codex` | 通知分组 |
| `BARK_TIMEOUT_MS` | `10000` | 请求超时，单位毫秒 |
| `BARK_DATA_DIR` | 项目下的 `data/` | 提醒数据库目录 |

系统或客户端传入的同名环境变量优先于 `.env`。

## 2. 接入 MCP 客户端

支持 `mcpServers` 格式的客户端可使用以下配置，将路径替换为本机项目的**绝对路径**：

```json
{
  "mcpServers": {
    "bark": {
      "command": "node",
      "args": [
        "--use-env-proxy",
        "/ABSOLUTE/PATH/TO/bark-local-mcp/src/server.mjs"
      ]
    }
  }
}
```

Windows 路径可写成 `E:/path/to/bark-local-mcp/src/server.mjs`。如果客户端找不到 `node`，将 `command` 改为 Node 可执行文件的完整路径。

Codex 用户可将 [clients/codex.toml](clients/codex.toml) 中的配置合并到 `~/.codex/config.toml`，同样需要替换路径。保存后重载 MCP 或重启客户端，客户端会自动启动服务，无需另开终端。

`--use-env-proxy` 使用启动环境中的代理配置；没有代理时直接连接。若客户端过滤环境变量，需要转发 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`。

## 3. 使用工具

连接后，可以直接对 Agent 说：“给我发一条测试通知”“半小时后提醒我喝水”“查看待发送提醒”或“取消刚才的提醒”。

| 工具 | 用途 | 主要参数 |
| --- | --- | --- |
| `send_notification` | 立即发送或创建定时提醒 | `user_requested`、消息内容、可选 `send_at` |
| `list_scheduled_notifications` | 查看提醒 | `include_completed`、`limit`、`offset` |
| `cancel_scheduled_notification` | 取消尚未发送的提醒 | `task_id`、`user_requested` |
| `check_service` | 检查 Bark 服务是否可达，不发送通知 | 无 |

发送和取消必须由用户明确要求，调用时传入 `user_requested: true`。任务完成或失败本身不代表允许发送通知。

发送示例：

```json
{
  "user_requested": true,
  "title": "喝水提醒",
  "body": "休息一下，喝点水。",
  "send_at": null
}
```

- **立即发送**：省略 `send_at` 或设为 `null`。
- **定时发送**：将 `send_at` 设为带时区的未来时间，如 `2027-01-01T15:30:00+08:00`。“半小时后”等说法由 Agent 换算为具体时间。
- **查看与取消**：创建提醒后返回 `task_id`，取消时使用这个 ID。默认只列出未完成提醒；`include_completed: true` 可查看历史。

消息至少包含 `title`、`subtitle`、`body`、`markdown` 中的一项。还支持分组、链接、图片、铃声等参数，具体字段由 MCP 工具描述提供；Bark 参数含义可参考[官方文档](https://bark.day.app/#/params)。`ttl` 控制历史保存时长，没有默认值，与定时发送无关。

`accepted` 表示 Bark 已接受请求，不代表手机已收到；`pending` 表示定时任务已保存。网络异常等导致结果不确定时记为 `unknown`，不会自动重试。

## 定时提醒如何运行

提醒保存在本机 SQLite 数据库中，由一个共享的 Node.js 后台进程执行，多个客户端不会各自重复发送。关闭 Agent 后，后台仍会运行。

- 电脑需要开机、联网；关机或睡眠期间无法发送，也不会主动唤醒电脑。
- 重启 MCP 或运行 `npm run scheduler:start` 可恢复待处理任务；晚到不超过 30 分钟的提醒会补发，超过则标记过期。
- 已开始发送的提醒无法取消，结果不确定的推送不会自动重试。

手动管理后台：

```sh
npm run scheduler:start
npm run scheduler:status
npm run scheduler:stop
```

Windows 可选启用登录自启动（当前用户启动项，不使用任务计划程序）：

```powershell
powershell.exe -NoProfile -File scripts/windows-autostart.ps1 Enable
```

将 `Enable` 换成 `Status` 可查看状态，换成 `Disable` 可移除。迁移项目目录后，需要更新客户端路径和启动项。

## 开发与检查

```sh
npm test       # 使用本机模拟服务运行测试
npm run check  # 检查真实 Bark 服务的健康状态
```

入口为 `src/server.mjs`，推送逻辑在 `src/bark.mjs`，调度与存储分别在 `src/scheduler.mjs`、`src/daemon.mjs` 和 `src/store.mjs`。
