# Cloudflare Workers + D1 部署

这条路线把同一个应用运行在 Cloudflare Workers 上，使用 D1 存储和静态资源。所有 Cloudflare 资源都在你自己的账号中创建；本仓库不包含任何生产环境的数据库 ID、域名、路由或存储桶。

## 前提

- Cloudflare 账号。
- Node.js 22 或更新版本。
- 唯一的六位 owner PIN。
- 长期稳定的随机 `AI_CONFIG_ENCRYPTION_KEY`。

## 部署

```sh
npm ci
npm run build
npx wrangler d1 create open-timer
cp wrangler.example.jsonc wrangler.jsonc
```

把 Wrangler 输出的 D1 名称和 ID 填入本地的 `wrangler.jsonc`。该文件已被 Git 忽略。

不把密钥写进配置文件，而是用 secret 设置：

```sh
npx wrangler secret put CLOCK_INITIAL_OWNER_PIN
npx wrangler secret put AI_CONFIG_ENCRYPTION_KEY
npx wrangler deploy
```

打开 Workers 地址或你配置的自定义域名，使用 owner PIN 登录。迁移会自动执行，并在 D1 中记录版本。

## 可选 R2 备份

R2 是可选功能。启用步骤：

1. 在账号中创建 R2 存储桶。
2. 在本地 `wrangler.jsonc` 添加名为 `BACKUP` 的 `r2_buckets` 绑定。
3. 按你的保留策略添加 cron 触发器。

没有该绑定时，备份请求会返回明确的“未配置”提示，定时事件也会安全跳过备份工作。

## 注意事项

- Workers 始终使用 Secure owner cookie，因此必须使用 HTTPS。
- AI 助手由 owner 在设置中配置；存在已加密 Key 时，加密主密钥必须保持不变。
- 对长期运行的部署做重大变更前，先在非生产 D1 数据库中导出数据并测试升级。