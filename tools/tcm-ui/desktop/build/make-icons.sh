#!/usr/bin/env bash
# 从 SVG 生成全套应用图标（改 SVG 后重跑本脚本即可，产物可复现）。
#
#   bash tools/tcm-ui/desktop/build/make-icons.sh
#
# 产物（electron-builder.yml 引用的就是这些）：
#   icon.png        512×512   macOS / Windows 图标源
#   tray.png        32×32     系统托盘
#   tray-16.png     16×16     托盘（小尺寸）
#   icons/NxN.png   16…512    Linux 的「尺寸命名目录」——
#                            app-builder 对单张 PNG 的尺寸检测会返回 0，装进 hicolor/0x0/ 主题查不到，
#                            必须用带尺寸的文件名（内核 desktop 那边踩过，见其 yml 注释）
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "✗ 需要 rsvg-convert（Debian/Ubuntu: apt install librsvg2-bin）" >&2
  exit 1
fi

mkdir -p icons
for s in 16 32 48 64 128 256 512; do
  rsvg-convert -w "$s" -h "$s" icon.svg -o "icons/${s}x${s}.png"
done
rsvg-convert -w 512 -h 512 icon.svg -o icon.png
rsvg-convert -w 32 -h 32 tray.svg -o tray.png
rsvg-convert -w 16 -h 16 tray.svg -o tray-16.png

echo "✓ 已生成："
ls -1 icon.png tray.png tray-16.png | sed 's/^/    /'
ls -1 icons/ | sed 's/^/    icons\//'
