# Docker 部署、备份、升级与恢复

Docker Compose + SQLite 是 Open Timer 推荐的自托管方式。

## 首次部署

```sh
git clone https://github.com/Evan-Joseph/open-timer.git
cd open-timer

# 可选：想固定到某个发布版本时，在 Releases 页面选好 tag 后执行：
# git checkout <release-tag>

cp .env.example .env
```

在 `.env` 中设置唯一的六位 `CLOCK_INITIAL_OWNER_PIN` 和足够长的随机 `AI_CONFIG_ENCRYPTION_KEY`，然后运行：

```sh
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:4517/api/v1/health
```

## 公网访问

Compose 默认只绑定 `127.0.0.1`，不要把明文 HTTP 端口直接暴露到公网。需要公网访问时：

1. 把 Open Timer 放在 HTTPS 反向代理之后。
2. 在 `.env` 中设置 `CLOCK_COOKIE_SECURE=true`。
3. 按代理需要设置 `CLOCK_BIND_ADDRESS`；同机部署代理时通常保持 `127.0.0.1` 即可。

## 数据与备份

命名卷 `open-timer-data` 保存 SQLite 数据库。升级前先备份：

```sh
docker compose exec open-timer /app/scripts/backup.sh
```

该脚本会在 `/data/backups` 下创建 SQLite 一致性的副本，并保留最近 14 份。请把这些文件复制到宿主机之外的存储。

需要完整卷归档时：

```sh
docker run --rm \
  -v open-timer-data:/data:ro \
  -v "$PWD":/backup \
  alpine:3.22 \
  tar czf /backup/open-timer-data-$(date +%F).tgz -C /data .
```

## 升级

1. 先备份。
2. 拉取新的源码版本。
3. 重新构建并启动：

   ```sh
   git pull --ff-only
   docker compose up -d --build
   ```

数据库迁移会在启动时自动执行。不要修改 `AI_CONFIG_ENCRYPTION_KEY`，否则需要重新输入已保存的所有 AI Key。

## 恢复

恢复前先停止应用：

```sh
docker compose down
```

把已知良好的 SQLite 备份恢复到 `open-timer-data` 卷中的 `clock.sqlite`，再执行 `docker compose up -d`。在已恢复实例验证通过前，保留当前卷的副本。

完整卷恢复时，请先创建新卷并解压归档，再启动 Compose。