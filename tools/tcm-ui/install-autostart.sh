#!/usr/bin/env bash
# 得一中医 · 问诊台 —— 开机自启安装/卸载
#
#   bash tools/tcm-ui/install-autostart.sh            安装（优先 systemd --user，否则 XDG autostart）
#   bash tools/tcm-ui/install-autostart.sh --uninstall 卸载
#   bash tools/tcm-ui/install-autostart.sh --status    看当前用哪种方式
#
# 为什么优先 systemd --user：崩溃能自动重启、可用 systemctl --user status 看状态。
# 没有 systemd --user 的环境（部分轻量桌面）回落到 XDG autostart（登录时拉起一次，不自动重启）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="${DEYI_UI_CONF:-$HOME/.deyi-tcm-ui.conf}"
UNIT_NAME="deyi-tcm-ui.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
DESKTOP_PATH="$HOME/.config/autostart/deyi-tcm-ui.desktop"
LAUNCHER="$HERE/tcm-ui.sh"

say() { printf '  %s\n' "$*"; }
die() { printf '  ✗ %s\n' "$*" >&2; exit 1; }

has_systemd_user() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user show-environment >/dev/null 2>&1
}

cmd_uninstall() {
  if [ -f "$UNIT_PATH" ]; then
    systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
    rm -f "$UNIT_PATH"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    say "已移除 systemd 用户服务：$UNIT_PATH"
  fi
  if [ -f "$DESKTOP_PATH" ]; then
    rm -f "$DESKTOP_PATH"
    say "已移除登录自启项：$DESKTOP_PATH"
  fi
  say "（进程若仍在运行：bash $LAUNCHER stop）"
}

cmd_status() {
  if [ -f "$UNIT_PATH" ]; then
    say "systemd 用户服务：已安装（$UNIT_PATH）"
    systemctl --user is-enabled "$UNIT_NAME" 2>/dev/null | sed 's/^/    enabled: /'
    systemctl --user is-active "$UNIT_NAME" 2>/dev/null | sed 's/^/    active:  /'
  elif [ -f "$DESKTOP_PATH" ]; then
    say "XDG 登录自启项：已安装（$DESKTOP_PATH）"
  else
    say "未安装开机自启"
  fi
}

cmd_install() {
  [ -f "$CONF" ] || die "还没有配置文件 —— 先跑一次：bash $LAUNCHER start（会生成 $CONF）"

  if has_systemd_user; then
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_PATH" <<EOF
[Unit]
Description=得一中医 · 问诊台（内核 + 独立前端）
Documentation=file://$HERE/README.md
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/env bash $LAUNCHER start
ExecStop=/usr/bin/env bash $LAUNCHER stop
TimeoutStartSec=120
# 内核/界面都是本机回环服务；崩溃后由 systemd 重新拉起
Restart=no

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT_NAME" || die "启用失败，看：systemctl --user status $UNIT_NAME"
    say "✓ 已装成 systemd 用户服务：$UNIT_PATH"
    say "  开机/登录后自动启动；现在已启动。"
    echo
    say "常用命令："
    say "  systemctl --user status  $UNIT_NAME"
    say "  systemctl --user restart $UNIT_NAME"
    say "  systemctl --user disable --now $UNIT_NAME   # 关掉自启"
    say "  bash $LAUNCHER status | logs | stop"
    echo
    say "注意：systemd --user 默认在「登录后」运行；若希望无人登录也常驻，"
    say "      需要一次性执行（可能要求管理员权限）： sudo loginctl enable-linger $USER"
  else
    mkdir -p "$(dirname "$DESKTOP_PATH")"
    cat > "$DESKTOP_PATH" <<EOF
[Desktop Entry]
Type=Application
Name=得一中医 · 问诊台
Comment=启动本机 MDH 内核与独立问诊界面
Exec=/usr/bin/env bash $LAUNCHER start
Icon=utilities-terminal
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
    say "✓ 已装成登录自启项：$DESKTOP_PATH"
    say "  （当前环境没有 systemd --user，所以只在登录时拉起一次，不会自动重启）"
  fi
}

case "${1:-install}" in
  --uninstall|uninstall) cmd_uninstall ;;
  --status|status)       cmd_status ;;
  install|"")            cmd_install ;;
  *) die "用法：$0 [install|--uninstall|--status]" ;;
esac
