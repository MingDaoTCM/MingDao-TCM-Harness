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

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/downloads"

# Release 刚创建时资产可能还没挂上 —— 2026-09-23 实测踩到：CI 建完 Release 的**同一分钟**跑部署，
# 查到 0 个资产、脚本却一路走完，最后上传了个空的下载区（页面上"清单为空"）。所以先等就绪再拉。
N=0
for i in $(seq 1 12); do
  N="$(curl -s -m 30 -H "Authorization: Bearer $GH_TOKEN" \
    "https://api.github.com/repos/$GH_REPO/releases/tags/$TAG" \
    | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("assets",[])))' 2>/dev/null || echo 0)"
  [ "${N:-0}" -gt 0 ] && break
  say "  Release 资产尚未就绪（第 $i/12 次，等 6s）…"
  sleep 6
done
[ "${N:-0}" -gt 0 ] || die "Release $TAG 没有任何安装包资产（CI 的 publish 作业是否失败？）"

python3 - "$GH_TOKEN" "$GH_REPO" "$TAG" "$WORK" <<'PY'
import json, sys, os, urllib.request
token, repo, tag, work = sys.argv[1:5]
req = urllib.request.Request(f"https://api.github.com/repos/{repo}/releases/tags/{tag}",
                             headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"})
rel = json.load(urllib.request.urlopen(req))
keep = (".exe", ".dmg", ".zip", ".AppImage", ".deb")
for a in rel.get("assets", []):
    if not a["name"].endswith(keep):
        continue
    r = urllib.request.Request(a["url"], headers={"Authorization": f"Bearer {token}", "Accept": "application/octet-stream"})
    dst = os.path.join(work, "downloads", a["name"])
    with urllib.request.urlopen(r) as resp, open(dst, "wb") as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    print(f"    ↓ {a['name']}  {a['size']/1048576:.1f} MB")
PY

# ── 生成 manifest.json（站点前台据它渲染下载卡）──
python3 - "$VER" "$WORK/downloads" <<'PY'
import hashlib, json, os, sys, datetime
ver, d = sys.argv[1:3]
def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()
files = []
for n in sorted(os.listdir(d)):
    if not n.endswith((".exe", ".dmg", ".zip", ".AppImage", ".deb")):
        continue
    p = os.path.join(d, n)
    files.append({"name": n, "size": os.path.getsize(p), "sha256": sha256(p)})json.dump({"version": ver, "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "files": files},
          open(os.path.join(d, "manifest.json"), "w"), ensure_ascii=False, indent=2)
print(f"    manifest.json：{len(files)} 个文件")
PY
# 0 个文件必须**当场失败**：否则会安静地上传一个空的下载区（页面显示"清单为空"），
# 而脚本一路绿 —— 2026-09-23 就是这么把空下载区发上去的。
NFILES="$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["files"]))' "$WORK/downloads/manifest.json" 2>/dev/null || echo 0)"
[ "${NFILES:-0}" -gt 0 ] || die "安装包清单是空的（0 个文件）—— 不要继续部署"

# ── 2) 上传 ────────────────────────────────────────────────────
step "2/4 上传文件到 $SERVER"
S "mkdir -p '$SITE_ROOT' '$SITE_ROOT/downloads' '$SERVER_DIR' '$DATA_DIR' '$SSL_DIR'"
S "chmod 700 '$DATA_DIR'"
scp -q -o ConnectTimeout=15 server.mjs "$SERVER:$SERVER_JS"
scp -q -o ConnectTimeout=15 -r public/. "$SERVER:$SITE_ROOT/"
scp -q -o ConnectTimeout=15 "$WORK/downloads/"* "$SERVER:$SITE_ROOT/downloads/"
scp -q -o ConnectTimeout=15 systemd/mingdao-tcm-site.service "$SERVER:$UNIT"
say "站点文件 / 服务 / 单元 已上传"

# ── 3) 证书（首次才签） ─────────────────────────────────────────
step "3/4 证书"
if S "test -f '$SSL_DIR/$DOMAIN.crt'"; then
  say "证书已存在，跳过签发（续期由 acme.sh 的 cron 负责）"
else
  say "证书不存在 —— 先只开 80 端口过 ACME 挑战，再上 443"
  cat > "$WORK/acme-only.conf" <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /usr/share/nginx/html; }
    location / { return 503; }
}
EOF
  scp -q -o ConnectTimeout=15 "$WORK/acme-only.conf" "$SERVER:$CONF"
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
