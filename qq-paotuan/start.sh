#!/usr/bin/env bash
# 单房间 · DND 5e 跑团平台
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 18+：https://nodejs.org"
  exit 1
fi

echo "启动后打开 http://localhost:${PORT:-8081}"
node server.js