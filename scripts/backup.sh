#!/usr/bin/env bash
# 每日 SQLite 备份：sqlite3 .backup → 带日期副本（保留 14 天）。
# 部署到云上后由 Cron Trigger / 定时触发器调用等价逻辑。
set -euo pipefail

DATA_DIR="${CLOCK_DATA_DIR:-$(cd "$(dirname "$0")/.." && pwd)/data}"
DB="$DATA_DIR/clock.sqlite"
BACKUP_DIR="$DATA_DIR/backups"

if [ ! -f "$DB" ]; then
  echo "backup skipped: $DB not found" >&2
  exit 0
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
sqlite3 "$DB" ".backup '$BACKUP_DIR/clock-$STAMP.sqlite'"
echo "backup written: $BACKUP_DIR/clock-$STAMP.sqlite"

# 保留最近 14 份
ls -1t "$BACKUP_DIR"/clock-*.sqlite 2>/dev/null | tail -n +15 | xargs -r rm -f
