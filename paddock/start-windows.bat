@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 围场 Paddock 演示版

where node >nul 2>nul
if errorlevel 1 (
  echo 还没有安装 Node.js。
  echo 请打开 https://nodejs.org/zh-cn ，下载 LTS 版本并安装，装好后再双击本文件。
  start "" "https://nodejs.org/zh-cn"
  pause
  exit /b 1
)

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo 你电脑上的 Node.js 版本太旧了。
  echo 请打开 https://nodejs.org/zh-cn ，下载最新的 LTS 版本安装，装好后再双击本文件。
  start "" "https://nodejs.org/zh-cn"
  pause
  exit /b 1
)

if not exist node_modules (
  echo 第一次运行，正在下载依赖……
  call npm install --no-audit --no-fund || call npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
)

node --disable-warning=ExperimentalWarning scripts\demo.js --open
pause
