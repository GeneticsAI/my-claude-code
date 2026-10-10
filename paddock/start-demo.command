#!/bin/bash
# 双击启动「围场 Paddock」演示模式（macOS）。关闭此窗口即停止。
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装 22.13 或更高版本：https://nodejs.org"
  read -n 1 -s -r -p "按任意键退出"
  exit 1
fi
[ -d node_modules ] || npm install
(sleep 2 && open "http://localhost:3000") &
npm run demo
