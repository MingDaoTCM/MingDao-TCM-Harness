#!/bin/bash
# 对齐上游内核到**最新 tag**。
#
# 为什么要有这个脚本：2026-11-15 我漏掉 v0.7/v0.8 整整两个大版本 ✗ ——
# 因为手写 `git tag -l 'v0.6.*'` 只匹配 v0.6 ✗。版本号一旦进入 0.7/0.8，
# 那个过滤就把新版本全屏蔽了，而且**看起来一切正常**（有输出、能对齐）。
# 现在只此一处：匹配**所有** vX.Y.Z，按版本排序取最后。
set -euo pipefail
cd "$(dirname "$0")/.."
K=${KERNEL:-../MingDao-Harness}
git -C "$K" fetch github --tags --force -q
LATEST=$(git -C "$K" ls-remote --tags github | grep -oE 'refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's#refs/tags/##' | sort -V | tail -1)
[ -n "$LATEST" ] || { echo "✗ 取不到最新 tag"; exit 1; }
echo "上游最新 tag: $LATEST"
git -C "$K" merge --ff-only "$LATEST"
VER=$(node -e "console.log(require('$K/package.json').version)")
echo "内核现为 v$VER"
python3 - "$VER" <<'PY'
import re, sys
v = sys.argv[1]
p = 'README.md'
s = open(p, encoding='utf-8').read()
n = re.sub(r'v0\.\d+\.\d+', 'v' + v, s)
if n != s:
    open(p, 'w', encoding='utf-8').write(n)
    print('README → v' + v)
PY
echo "✓ 完成（记得跑门禁与 preflight 再打 tag）"
