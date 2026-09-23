#!/usr/bin/env bash
# 把「明道中医 · 问诊台」站点发布到**与官网共用的那台服务器**（tcm.mingdao.ai）。
#
#   bash site/deploy.sh              # 用最新的 GitHub Release
#   bash site/deploy.sh v0.1.1       # 指定版本
#   TCM_SERVER=other-host bash site/deploy.sh
#
# 做四件事：
#   ① 从 GitHub Release 拉安装包 → 算 sha256/大小 → 生成 downloads/manifest.json
#   ② 上传站点文件 / 服务 / systemd 单元 / openresty vhost
#   ③ 首次部署时用 acme.sh 签发证书（分两阶段：先只开 80 端口过 ACME，再上 443）
#   ④ 重启服务、reload openresty、自检
#
# 幂等：重复跑只覆盖文件、重启服务；证书已存在就不重签；密码不会被动（auth.json 在数据目录里）。
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
REPO_DIR="$(cd .. && pwd)"

SERVER="${TCM_SERVER:-mingdao-server}"
DOMAIN="tcm.mingdao.ai"
GH_REPO="MingDaoTCM/MingDao-TCM-Harness"

SITE_ROOT="/opt/1panel/www/sites/tcm-site"
SERVER_DIR="/opt/mingdao"
SERVER_JS="$SERVER_DIR/tcm-site-server.js"
UNIT="/etc/systemd/system/mingdao-tcm-site.service"
CONF="/opt/1panel/www/conf.d/tcm.conf"
SSL_DIR="/opt/1panel/apps/openresty/openresty/conf/ssl"
ACME_WEBROOT="/opt/1panel/apps/openresty/openresty/root"
DATA_DIR="/var/lib/mingdao-tcm-site"
ORESTY_CONTAINER="${ORESTY_CONTAINER:-}"

say() { printf '  %s\n' "$*"; }
die() { printf '  ✗ %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s ==\n' "$*"; }

S() { ssh -o ConnectTimeout=15 -o BatchMode=yes "$SERVER" "$@"; }

# ── GitHub token（TCM 仓库是私有的，下载 Release 资产要它）──
GH_TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$GH_TOKEN" ] && [ -f "$REPO_DIR/../MingDao-Harness/.env" ]; then
  GH_TOKEN="$(grep -m1 '^MINGDAO_GITHUB_TOKEN=' "$REPO_DIR/../MingDao-Harness/.env" | cut -d= -f2- || true)"
fi
[ -n "$GH_TOKEN" ] || die "找不到 GitHub token（设 GITHUB_TOKEN，或让 ../MingDao-Harness/.env 里有 MINGDAO_GITHUB_TOKEN）"

# ── 1) 取版本与安装包 ───────────────────────────────────────────
step "1/4 拉安装包（$GH_REPO）"
TAG="${1:-}"
if [ -z "$TAG" ]; then
  TAG="$(curl -s -m 30 -H "Authorization: Bearer $GH_TOKEN" \
    "https://api.github.com/repos/$GH_REPO/releases/latest" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("tag_name",""))')"
fi
[ -n "$TAG" ] || die "取不到 Release tag"
VER="${TAG#v}"
say "版本：$TAG"

# ── 取安装包：**交给服务器自己去拉**，本机不下载 ───────────────────────────
# 实测（2026-09-23）：本机 → GitHub ≈ 40KB/s，服务器 → GitHub ≈ 130KB/s，
# 而这台服务器**上行只有 50–100KB/s**（上游脚本里自己写明的）。
# 所以"本机拉好再 scp 上去"等于把 500MB 走两遍慢链路 —— 让服务器自己拉，且丢后台：
# 站点先立起来，包慢慢到位（manifest.json 只在全齐后才出现，页面看到的就是完整的）。
say "把取包任务丢到服务器后台（本机不经手那 500MB）"
scp -q -o ConnectTimeout=15 fetch-assets.py "$SERVER:/opt/mingdao/tcm-fetch-assets.py"
S "mkdir -p '$SITE_ROOT/downloads'"
# token 落到服务器上的 0600 临时文件，脚本读完**立即 unlink** —— 既不进 argv/ps，
# 也不受"ssh 通道比后台进程先关"的时序影响（后者实测让 --token-stdin 拿不到 token）。
TMPTOK="$SERVER_DIR/.tcm-token"
S "umask 077 && cat > '$TMPTOK'" <<<"$GH_TOKEN"
# 注意用 ( ... & ) 子 shell：直接 `a && b && nohup x &` 会把整条链都放后台，
# 于是后面的 rm/log 与读日志互相抢时序（实测：head 报"文件不存在"）。
S "cd '$SERVER_DIR' && rm -f tcm-fetch.log && (nohup python3 tcm-fetch-assets.py --repo '$GH_REPO' --tag '$TAG' --dir '$SITE_ROOT/downloads' --token-file '$TMPTOK' > '$SERVER_DIR/tcm-fetch.log' 2>&1 < /dev/null &) ; echo '  后台任务已启动'"
sleep 6
say "  日志开头：$(S "head -3 $SERVER_DIR/tcm-fetch.log 2>/dev/null | tr '\n' ' '")"
say "  看进度：ssh $SERVER 'tail -f $SERVER_DIR/tcm-fetch.log'"

# ── 2) 上传 ────────────────────────────────────────────────────
step "2/4 上传文件到 $SERVER"
S "mkdir -p '$SITE_ROOT' '$SITE_ROOT/downloads' '$SERVER_DIR' '$DATA_DIR' '$SSL_DIR'"
S "chmod 700 '$DATA_DIR'"
scp -q -o ConnectTimeout=15 server.mjs "$SERVER:$SERVER_JS"
scp -q -o ConnectTimeout=15 -r public/. "$SERVER:$SITE_ROOT/"
scp -q -o ConnectTimeout=15 systemd/mingdao-tcm-site.service "$SERVER:$UNIT"
say "站点文件 / 服务 / 单元 已上传（安装包由服务器后台自己拉，见上一步）"

# ── 3) 证书（首次才签） ─────────────────────────────────────────
step "3/4 证书"
if S "test -f '$SSL_DIR/$DOMAIN.crt'"; then
  say "证书已存在，跳过签发（续期由 acme.sh 的 cron 负责）"
else
  say "证书不存在 —— 先只开 80 端口过 ACME 挑战，再上 443"
  TMPCONF="$(mktemp)"
  cat > "$TMPCONF" <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /usr/share/nginx/html; }
    location / { return 503; }
}
EOF
  scp -q -o ConnectTimeout=15 "$TMPCONF" "$SERVER:$CONF"
  rm -f "$TMPCONF"
  S "docker exec \$(docker ps --format '{{.Names}}' | grep -i openresty | head -1) openresty -s reload" 2>/dev/null || true
  sleep 1
  # --server letsencrypt：与官网那两张证书**同一个 CA**。
  # acme.sh 现在默认 ZeroSSL，会先要邮箱/EAB 凭据（首次部署实测就卡在这）。
  S "~/.acme.sh/acme.sh --issue -d '$DOMAIN' --webroot '$ACME_WEBROOT' --keylength ec-256 --server letsencrypt" \
    || die "acme.sh 签发失败（DNS 是否已指向本机？80 端口是否可达？）"
  S "~/.acme.sh/acme.sh --install-cert -d '$DOMAIN' --ecc \
       --key-file '$SSL_DIR/$DOMAIN.key' --fullchain-file '$SSL_DIR/$DOMAIN.crt' --reloadcmd 'true'"
  say "证书已签发并安装"
fi

# ── 4) 上 vhost + 起服务 ───────────────────────────────────────
step "4/4 上 vhost / 起服务 / 自检"
scp -q -o ConnectTimeout=15 nginx/tcm.conf "$SERVER:$CONF"
C="\$(docker ps --format '{{.Names}}' | grep -i openresty | head -1)"
S "docker exec $C openresty -t" || die "openresty 配置校验失败（见上）"
S "systemctl daemon-reload && systemctl enable mingdao-tcm-site >/dev/null 2>&1 && systemctl restart mingdao-tcm-site"
sleep 2
S "systemctl is-active mingdao-tcm-site" >/dev/null || { S "journalctl -u mingdao-tcm-site -n 30 --no-pager"; die "服务没起来"; }
S "docker exec $C openresty -s reload"
say "服务与 vhost 已生效"

# 首次部署时把初始密码带出来（服务只在生成那次打日志）
INIT="$(S "journalctl -u mingdao-tcm-site --no-pager -n 200 | grep -o '已生成初始密码：[^ ]*' | tail -1" || true)"
if [ -n "$INIT" ]; then
  say "⚠ ${INIT}    ← 首次登录用；进 /admin 改掉后请删掉 $DATA_DIR/INITIAL-PASSWORD.txt"
fi

echo
say "自检："
CODE="$(curl -s -o /tmp/tcm-index.html -w '%{http_code}' -m 20 "https://$DOMAIN/" || echo 000)"
say "  https://$DOMAIN/ → HTTP $CODE"
if [ "$CODE" = "200" ] && grep -q '需要访问密码' /tmp/tcm-index.html; then
  say "  ✓ 未登录看到的是登录页（密码门生效）"
else
  say "  ⚠ 首页没返回登录页，去服务器看：journalctl -u mingdao-tcm-site -n 50 --no-pager"
fi
say "  安装包：https://$DOMAIN/ （登录后可见）；后台：https://$DOMAIN/admin"
