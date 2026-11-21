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
# 只改「对齐 **MingDao-Harness vX.Y.Z**」这一处正式声明。
# 早先的正则 `v0\.\d+\.\d+` 会把 README 里**所有** v0.x.y 都改掉 —— 包括历史叙述里的
# 旧版本号（如"当天先是内核到 v0.8.1、README 还写 0.6.10"），历史记录被抹平成最新版 ✗，
# 且硬编码 v0 前缀，内核升到 v1.x 就再也匹配不上。
n = re.sub(r'(对齐\s*\*\*MingDao-Harness\s+v)\d+\.\d+\.\d+(\*\*)', r'\g<1>' + v + r'\g<2>', s)
if n != s:
    open(p, 'w', encoding='utf-8').write(n)
    print('README 对齐声明 → v' + v)
PY
echo "✓ 完成（记得跑门禁与 preflight 再打 tag）"

# ── engines 窗口校验（2026-11-21 加）──
# 为什么必须有：窗口写成 ">=0.5 <0.7" 时，内核一旦到 0.8.1，
# 内核会**拒绝挂载整个垂域层** ✗，而哨兵的报错是「只有 1 个工具」——离根因很远 ✗。
# 这条检查让"窗口过期"在**对齐当时**就红，而不是等到发版前。
python3 - "$VER" <<'PY2'
import json, re, sys, glob
ver = sys.argv[1]
cur = tuple(int(x) for x in (ver.split('.') + ['0', '0'])[:3])
bad = []
for mf in glob.glob('layer/packs/*/pack.json'):
    try: m = json.load(open(mf, encoding='utf-8'))
    except Exception as e: bad.append(f'{mf}: 解析失败 {e}'); continue
    win = str(((m.get('engines') or {}).get('mingdao')) or '')
    ok = True
    for part in win.split():
        mm = re.match(r'^([<>]=?|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$', part.strip())
        if not mm: continue
        op = mm.group(1) or '='
        a = int(mm.group(2)); b = int(mm.group(3) or 0); c = int(mm.group(4) or 0)
        t = (a, b, c)
        if op == '>=' and not (cur >= t): ok = False
        elif op == '>' and not (cur > t): ok = False
        elif op == '<=' and not (cur <= t): ok = False
        elif op == '<' and not (cur < t): ok = False
        elif op == '=' and not (cur == t): ok = False
    if not ok:
        bad.append(f'{mf}: engines.mingdao="{win}" 不含当前内核 {ver}')
if bad:
    print('✗ engines 窗口与内核对不上（内核会拒绝挂载整个垂垂域层）：')
    for b in bad: print('  ' + b)
    print('  修：把窗口放宽到覆盖当前内核后重跑。')
    sys.exit(1)
print('✓ engines 窗口覆盖当前内核 ' + ver)
PY2
