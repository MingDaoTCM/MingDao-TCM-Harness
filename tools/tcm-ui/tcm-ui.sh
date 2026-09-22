#!/usr/bin/env bash
# 得一中医 · 问诊台 —— 一键启停
#
#   bash tools/tcm-ui/tcm-ui.sh start     启动内核 + 界面（已在跑就跳过）
#   bash tools/tcm-ui/tcm-ui.sh stop      停止两者
#   bash tools/tcm-ui/tcm-ui.sh restart   重启
#   bash tools/tcm-ui/tcm-ui.sh status    看状态与地址
#   bash tools/tcm-ui/tcm-ui.sh logs      跟踪日志（Ctrl+C 退出）
#
# 配置写在 ~/.deyi-tcm-ui.conf（首次运行本脚本会自动生成模板）。
# 想开机自启：bash tools/tcm-ui/install-autostart.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="${DEYI_UI_CONF:-$HOME/.deyi-tcm-ui.conf}"
RUN_DIR="${DEYI_UI_RUN_DIR:-$HOME/.deyi-tcm-ui}"
mkdir -p "$RUN_DIR"

# ── 默认值（可被 conf 覆盖） ────────────────────────────────
MINGDAO_KERNEL="${MINGDAO_KERNEL:-}"
MINGDAO_HOME="${MINGDAO_HOME:-}"
KERNEL_PORT="${KERNEL_PORT:-3821}"
UI_PORT="${UI_PORT:-3830}"
NODE_BIN="${NODE_BIN:-}"
[ -f "$CONF" ] && . "$CONF"

say()  { printf '  %s\n' "$*"; }
die()  { printf '  ✗ %s\n' "$*" >&2; exit 1; }

# ── 自动发现：内核检出目录 & MINGDAO_HOME ──────────────────
# 在候选检出里挑**版本最高**的：机器上常同时存在旧克隆与新快照
# （例：MingDao-Harness 是 v0.4.6 的旧克隆，MingDao-Harness-v0.6.3 才是当前上游）。
discover_kernel() {
  local c best="" bestver=""
  for c in \
    "$HOME/AI/DeepSeek-harness-Space/MingDao-Harness" \
    "$HOME/AI/DeepSeek-harness-Space"/MingDao-Harness-v* \
    "$HOME/AI/DeepSeek-harness-Space"/MingDao-Harness-* \
    "$HOME/MingDao-Harness"; do
    [ -f "$c/src/cli.js" ] || continue
    local ver
    ver="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9][^"]*\)".*/\1/p' "$c/package.json" 2>/dev/null | head -1)"
    [ -z "$ver" ] && continue
    if [ -z "$bestver" ] || [ "$(printf '%s\n%s\n' "$ver" "$bestver" | sort -V | tail -1)" = "$ver" ] && [ "$ver" != "$bestver" ]; then
      best="$c"; bestver="$ver"
    fi
  done
  [ -n "$best" ] && { printf '%s' "$best"; return 0; }
  return 1
}
if [ -z "$MINGDAO_KERNEL" ] || [ ! -f "$MINGDAO_KERNEL/src/cli.js" ]; then
  MINGDAO_KERNEL="$(discover_kernel || true)"
fi
if [ -z "$MINGDAO_HOME" ]; then
  for h in "$HOME/.mingdao-dify-test" "$HOME/.deyi-tcm" "$HOME/.mingdao"; do
    [ -f "$h/credentials.json" ] && { MINGDAO_HOME="$h"; break; }
  done
fi

write_conf_template() {
  [ -f "$CONF" ] && return 0
  cat > "$CONF" <<EOF
# 得一中医 · 问诊台配置（本文件由 tcm-ui.sh 首次运行生成，可手工编辑）
MINGDAO_KERNEL="$MINGDAO_KERNEL"
MINGDAO_HOME="$MINGDAO_HOME"
KERNEL_PORT=$KERNEL_PORT
UI_PORT=$UI_PORT
# node 留空则每次启动自动挑一个 fetch 可用的（本机 /usr/bin/node v20.15.1 是坏的）
NODE_BIN=""
EOF
  say "已生成配置：$CONF"
}

# ── 挑一个「fetch 真能用」的 node ──────────────────────────
#
# 为什么不能只查版本号：实测本机 /usr/bin/node (v20.15.1, dpkg 包 nodejs) 的安装是**坏的** ——
# 起得来、`node --version` 正常、跑内核也没事，但内置 `fetch()` 一调就抛
#   [CompileError: WebAssembly.compile(): section (code 10, "Code") extends past end of the module]
# 并伴随一个 unhandled rejection 直接崩进程。
# 而薄代理**全靠 fetch 转发**，于是表现成「界面能打开、一刷新数据就 502 / 进程消失」。
# systemd 用户会话的 PATH 只有 /usr/bin，交互 shell 里却先命中 ~/.local 的 v24 —— 所以
# 「我在终端里跑是好的」和「开机自启后打不开」会同时成立。
#
# 结论：必须做一次真实的 fetch 冒烟测试，而不是信版本号或 PATH 顺序。
node_ok() {
  local n="$1"
  [ -x "$n" ] || return 1
  # ⚠ 判据必须是**退出码**，不能只看 stdout。
  # 实测坏 node 会先把 fetch 的 reject 抛给你（被 try 吞掉）、照常打印 OK，
  # 然后才因子进程内部的 unhandled rejection 崩掉 —— 只看输出会**假通过**。
  timeout 12 "$n" --input-type=module -e '
    try { await fetch("http://127.0.0.1:1/", { signal: AbortSignal.timeout(3000) }); } catch {}
  ' >/dev/null 2>&1
}
pick_node() {
  local c
  if [ -n "${NODE_BIN:-}" ] && node_ok "$NODE_BIN"; then printf '%s' "$NODE_BIN"; return 0; fi
  for c in $(which -a node 2>/dev/null) \
           /usr/local/bin/node /usr/bin/node \
           "$HOME"/.local/node-*/bin/node "$HOME"/.nvm/versions/node/*/bin/node \
           /opt/node*/bin/node; do
    node_ok "$c" && { printf '%s' "$c"; return 0; }
  done
  return 1
}

# ── 端口 / 进程工具 ────────────────────────────────────────
pid_on_port() {
  local p="$1"
  # ss 的输出里取 pid= 字段；不同发行版字段名有差异，兜底用 fuser
  local pid
  pid="$(ss -ltnp 2>/dev/null | awk -v port=":$p" '$4 ~ port {print $0}' | grep -oP 'pid=\K[0-9]+' | head -1)"
  [ -n "$pid" ] && { printf '%s' "$pid"; return 0; }
  pid="$(fuser -n tcp "$p" 2>/dev/null | tr -d ' ')"
  [ -n "$pid" ] && { printf '%s' "$pid"; return 0; }
  return 1
}
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# 健康检查一律**轮询端口**，不信 `$!`：
# 经 setsid/nohup 之后 `$!` 记到的是包装进程，真正监听的 node 往往是它的子进程
# （实测记录到 28845、实际监听 28847）。端口应答才是「起来了」的唯一可靠判据。
wait_http() {
  local url="$1" tries="${2:-25}" i=0
  while [ "$i" -lt "$tries" ]; do
    if curl -s -o /dev/null -m 2 "$url"; then return 0; fi
    i=$((i + 1)); sleep 1
  done
  return 1
}

# ── start / stop ───────────────────────────────────────────
cmd_start() {
  [ -n "$MINGDAO_KERNEL" ] && [ -f "$MINGDAO_KERNEL/src/cli.js" ] || die "找不到 MingDao-Harness 内核检出；请在 $CONF 里设置 MINGDAO_KERNEL"
  [ -n "$MINGDAO_HOME" ] && [ -d "$MINGDAO_HOME" ] || die "找不到 MINGDAO_HOME；请在 $CONF 里设置（例：\$HOME/.deyi-tcm）"

  NODE_BIN="$(pick_node || true)"
  [ -n "$NODE_BIN" ] || die "找不到一个 fetch 可用的 node。请在 $CONF 里显式指定，例：NODE_BIN=\"$HOME/.local/node-v24.19.0-linux-x64/bin/node\""
  say "node： $NODE_BIN（$("$NODE_BIN" --version 2>&1)）"
  # 把选中的 node 写回配置固定下来：避免每次启动都重新探测，
  # 也让你能一眼看到「这台机器上最终用的是哪个 node」。
  if [ -f "$CONF" ]; then
    if grep -q '^NODE_BIN=' "$CONF" 2>/dev/null; then
      grep -q '^NODE_BIN=""' "$CONF" 2>/dev/null && \
        sed -i "s|^NODE_BIN=\"\"|NODE_BIN=\"$NODE_BIN\"|" "$CONF" && say "已把 NODE_BIN 写入 $CONF"
    else
      # 老配置（本功能之前生成的）没有这一行 —— 追加，避免每次启动重新探测
      printf 'NODE_BIN="%s"\n' "$NODE_BIN" >> "$CONF" && say "已把 NODE_BIN 追加到 $CONF"
    fi
  fi

  local kpid upid
  kpid="$(pid_on_port "$KERNEL_PORT" || true)"
  if alive "$kpid"; then
    say "内核已在运行（端口 $KERNEL_PORT，pid $kpid）"
  else
    # setsid + </dev/null：彻底脱离当前会话（新会话、无控制终端）。
    # 否则：① 父 shell 退出时子进程可能收到 SIGHUP；② 调用方（脚本/终端/CI）会一直等
    # 这几个继承下去的 fd 关闭 —— 表现为「脚本明明跑完了却卡住不返回」。
    ( cd "$MINGDAO_KERNEL" && MINGDAO_HOME="$MINGDAO_HOME" \
        setsid nohup "$NODE_BIN" src/cli.js web "$KERNEL_PORT" > "$RUN_DIR/kernel.log" 2>&1 < /dev/null & \
        echo $! > "$RUN_DIR/kernel.pid"; disown 2>/dev/null || true )
    if wait_http "http://127.0.0.1:$KERNEL_PORT/api/state" 25; then
      say "内核已启动（端口 $KERNEL_PORT）"
    else
      say "内核启动失败，日志尾部："; tail -12 "$RUN_DIR/kernel.log" | sed 's/^/    /'; die "启动中止"
    fi
  fi

  upid="$(pid_on_port "$UI_PORT" || true)"
  if alive "$upid"; then
    say "界面已在运行（端口 $UI_PORT，pid $upid）"
  else
    setsid nohup "$NODE_BIN" "$HERE/server.mjs" --target "http://127.0.0.1:$KERNEL_PORT" --port "$UI_PORT" --home "$MINGDAO_HOME" \
      > "$RUN_DIR/ui.log" 2>&1 < /dev/null & echo $! > "$RUN_DIR/ui.pid"; disown 2>/dev/null || true
    if wait_http "http://127.0.0.1:$UI_PORT/" 15; then
      say "界面已启动（端口 $UI_PORT）"
    else
      say "界面启动失败，日志："; tail -12 "$RUN_DIR/ui.log" | sed 's/^/    /'; die "启动中止"
    fi
  fi

  echo
  say "打开： http://127.0.0.1:$UI_PORT/"
  say "内核： $MINGDAO_KERNEL"
  say "数据： $MINGDAO_HOME"
}

cmd_stop() {
  local p name pid
  for pair in "$UI_PORT:界面" "$KERNEL_PORT:内核"; do
    p="${pair%%:*}"; name="${pair##*:}"
    pid="$(pid_on_port "$p" || true)"
    if alive "$pid"; then
      kill "$pid" 2>/dev/null && say "已停止$name（端口 $p，pid $pid）"
    else
      say "$name未在运行（端口 $p）"
    fi
  done
  rm -f "$RUN_DIR/kernel.pid" "$RUN_DIR/ui.pid"
  # 内核有自己的子进程/监听，稍等确认端口释放
  sleep 1
  for p in "$UI_PORT" "$KERNEL_PORT"; do
    pid="$(pid_on_port "$p" || true)"
    alive "$pid" && say "⚠ 端口 $p 仍被 pid $pid 占用，可手工 kill"
  done
}

cmd_status() {
  local p name pid
  for pair in "$KERNEL_PORT:内核" "$UI_PORT:界面"; do
    p="${pair%%:*}"; name="${pair##*:}"
    pid="$(pid_on_port "$p" || true)"
    if alive "$pid"; then say "✓ $name 运行中（端口 $p，pid $pid）"; else say "✗ $name 未运行（端口 $p）"; fi
  done
  echo
  say "界面地址： http://127.0.0.1:$UI_PORT/"
  say "内核目录： ${MINGDAO_KERNEL:-（未配置）}"
  say "数据目录： ${MINGDAO_HOME:-（未配置）}"
  say "配置：     $CONF"
  say "日志目录： $RUN_DIR"
}

cmd_logs() {
  say "内核 $RUN_DIR/kernel.log ／ 界面 $RUN_DIR/ui.log（Ctrl+C 退出）"
  tail -n 30 -F "$RUN_DIR/kernel.log" "$RUN_DIR/ui.log" 2>/dev/null
}

write_conf_template
case "${1:-start}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; echo; cmd_start ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  *) die "用法：$0 {start|stop|restart|status|logs}" ;;
esac
