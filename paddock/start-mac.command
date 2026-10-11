#!/bin/bash
# 双击启动「围场 Paddock」演示版（macOS）。关闭这个窗口即停止。
cd "$(dirname "$0")"

pause_exit() {
  echo
  read -n 1 -s -r -p "按任意键关闭窗口……"
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  echo "还没有安装 Node.js。"
  echo "请打开 https://nodejs.org/zh-cn ，下载 LTS 版本并安装，装好后再双击本文件。"
  open "https://nodejs.org/zh-cn" 2>/dev/null
  pause_exit
fi

if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  echo "你电脑上的 Node.js 版本（$(node -v)）太旧了。"
  echo "请打开 https://nodejs.org/zh-cn ，下载最新的 LTS 版本安装，装好后再双击本文件。"
  open "https://nodejs.org/zh-cn" 2>/dev/null
  pause_exit
fi

if [ ! -d node_modules ]; then
  echo "第一次运行，正在下载依赖……"
  npm install --no-audit --no-fund || npm install --no-audit --no-fund --registry=https://registry.npmmirror.com || pause_exit
fi

node --disable-warning=ExperimentalWarning scripts/demo.js --open || pause_exit
