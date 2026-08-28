# 配置参考

Open Timer 在进程启动时读取环境变量。密钥请放在部署平台的密钥存储中，不要提交到 `.env`、`wrangler.jsonc`、截图或 Issue 里。

## 生产环境必需项

| 变量 | 是否必需 | 说明 |
| --- | --- | --- |
| `CLOCK_INITIAL_OWNER_PIN` | 是 | 恰好六位数字。在公网实例接受请求前用于创建 owner；Docker Compose 在该值为空时拒绝启动。 |
| `AI_CONFIG_ENCRYPTION_KEY` | 需要保存 owner 填写的 AI Key 时必需 | 用于加密 API Key 的长随机密钥。必须保持稳定；修改后已有密文无法解密。 |

基础计时不要求 `AI_CONFIG_ENCRYPTION_KEY`，但 Docker 快速开始把它设为必需，以便 owner 之后可以安全启用 AI。

## 运行配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLOCK_PORT` | `4517` | Node 服务的 HTTP 监听端口。 |
| `CLOCK_DATA_DIR` | `./data` | 未设置 `CLOCK_DB_PATH` 时存放 SQLite 数据库的目录；Docker 使用 `/data`。 |
| `CLOCK_DB_PATH` | `$CLOCK_DATA_DIR/clock.sqlite` | Node 部署下的 SQLite 数据库显式路径。 |
| `CLOCK_BASE_URL` | `http://127.0.0.1:4517` | Node 配置使用的基础地址。 |
| `NODE_ENV` | 未设置 | 公网部署设为 `production`。 |
| `CLOCK_COOKIE_SECURE` | 跟随 `NODE_ENV` | 为 `true` 时发送 Secure owner cookie，要求 HTTPS；Docker 的 localhost 默认是 `false`，在 HTTPS 反向代理后设置为 `true`。 |
| `CLOCK_MIN_SEGMENT_SECONDS` | `10` | 短于该值的已关闭片段作为误触不计入；`0` 表示关闭该过滤。 |

## 仅 Docker Compose 的配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLOCK_BIND_ADDRESS` | `127.0.0.1` | Compose 端口发布使用的主机地址。本地使用保持默认；仅在信任的网络或反向代理场景下有意识地修改。 |

## AI 配置

推荐方式：在“设置 → AI 助手”中由 owner 选择 provider、API Base、模型和 Key。应用支持硅基流动的 `https://api.siliconflow.cn/v1` 预设，以及其他公开 HTTPS OpenAI 兼容接口。

以下可选环境变量作为兼容旧版自动化使用的 AI provider 兜底：

| 变量 | 说明 |
| --- | --- |
| `CONCH_API_BASE` | OpenAI 兼容 API 基础地址。 |
| `CONCH_API_KEY` | provider 的 API Key；用部署密钥保存。 |
| `CONCH_MODEL` | provider 的模型标识。 |
| `CONCH_THINKING_BUDGET` | 可选的正整数思考 token 预算。 |

兜底方式对已有自动化有用；新部署建议优先使用设置页，因为它让配置由 owner 管理、密钥加密保存在应用数据库中。