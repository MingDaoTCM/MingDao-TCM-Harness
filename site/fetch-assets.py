#!/usr/bin/env python3
# 在**服务器上**跑：把某个 GitHub Release 的安装包拉到站点 downloads/，并生成 manifest.json。
#
# 为什么要在服务器上跑、而不是本机拉好再 scp：
#   实测（2026-09-23）本机 → GitHub 约 40KB/s、服务器 → GitHub 约 130KB/s，
#   而这台服务器的上行只有 50–100KB/s（上游脚本里自己写明的）。
#   也就是说：**谁去 GitHub 拉都比本机快**，而"本机拉好再传上来"等于把 500MB 走两遍慢链路。
#   所以交给服务器自己拉，而且丢到 nohup 后台 —— 站点先立起来，包慢慢到位。
#
# 用法（在服务器上）：
#   GH_TOKEN=xxx python3 fetch-assets.py --repo owner/name --tag v0.1.1 --dir /opt/.../downloads
# token 也可以从 stdin 读（避免进 argv / ps）：
#   echo "$TOKEN" | python3 fetch-assets.py --repo ... --tag ... --dir ... --token-stdin
#
# manifest.json **只在全部文件下完后**才原子写入 —— 否则页面会显示一份残缺的下载清单。
import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request
import datetime

KEEP = ('.exe', '.dmg', '.zip', '.AppImage', '.deb')


def api(url, token, accept='application/vnd.github+json'):
    req = urllib.request.Request(url, headers={
        'Authorization': 'Bearer ' + token,
        'Accept': accept,
        'User-Agent': 'mingdao-tcm-site-fetch',
    })
    return urllib.request.urlopen(req, timeout=60)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def download(url, token, dst):
    """带断点重试：这个网络环境丢连接很常见，重试必须能从已下部分继续。"""
    for attempt in range(1, 21):
        have = os.path.getsize(dst) if os.path.exists(dst) else 0
        headers = {
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/octet-stream',
            'User-Agent': 'mingdao-tcm-site-fetch',
        }
        if have:
            headers['Range'] = 'bytes=%d-' % have
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as r:
                total = r.headers.get('Content-Length')
                if have and r.status != 206:
                    have = 0  # 服务端不认 Range，从头来
                    mode = 'wb'
                else:
                    mode = 'ab' if have else 'wb'
                got = have
                t0 = time.time()
                with open(dst, mode) as f:
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        if time.time() - t0 > 30:
                            t0 = time.time()
                            print('      ... %d/%s MB' % (got >> 20, (int(total) >> 20) if total else '?'), flush=True)
                return got
        except Exception as e:  # noqa: BLE001 —— 网络异常种类多，一律重试
            print('      第 %d 次中断（%s），5s 后续传' % (attempt, e), flush=True)
            time.sleep(5)
    raise SystemExit('下载失败：重试 20 次仍未完成')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True)
    ap.add_argument('--tag', required=True)
    ap.add_argument('--dir', required=True)
    ap.add_argument('--token-stdin', action='store_true')
    ap.add_argument('--token-file', help='读这个文件里的 token，**读完立即 unlink**')
    a = ap.parse_args()
    if a.token_file:
        # 为什么要这个：`nohup ... --token-stdin &` 时 ssh 通道会立刻关闭，
        # 后起的 python 还没来得及读 stdin 就拿到 EOF（2026-09-23 实测踩到，日志是"缺少 token"）。
        # 落到 0600 文件、读完立刻删 —— 比"让 token 进 argv"安全，且不受通道时序影响。
        with open(a.token_file) as f:
            token = f.read().strip()
        try:
            os.unlink(a.token_file)
        except OSError:
            pass
    elif a.token_stdin:
        token = sys.stdin.read().strip()
    else:
        token = os.environ.get('GH_TOKEN', '')
    if not token:
        raise SystemExit('缺少 token（--token-file / --token-stdin / GH_TOKEN）')

    os.makedirs(a.dir, exist_ok=True)
    rel = json.load(api('https://api.github.com/repos/%s/releases/tags/%s' % (a.repo, a.tag), token))
    assets = [x for x in rel.get('assets', []) if x['name'].endswith(KEEP)]
    if not assets:
        raise SystemExit('Release %s 没有可发布的安装包' % a.tag)
    print('  共 %d 个安装包' % len(assets), flush=True)

    files = []
    for x in assets:
        name, dst = x['name'], os.path.join(a.dir, x['name'])
        print('  ↓ %s (%.1f MB)' % (name, x['size'] / 1048576.0), flush=True)
        got = download(x['url'], token, dst)
        if got != x['size']:
            raise SystemExit('%s 大小不符：得到 %d，期望 %d' % (name, got, x['size']))
        files.append({'name': name, 'size': got, 'sha256': sha256(dst)})
        print('    ✓ %s' % name, flush=True)

    # 原子写：manifest 只在全齐之后出现（页面据它渲染，残缺清单比没有更糟）
    manifest = {
        'version': a.tag.lstrip('v'),
        'generatedAt': datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z',
        'files': sorted(files, key=lambda f: f['name']),
    }
    tmp = os.path.join(a.dir, '.manifest.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    os.replace(tmp, os.path.join(a.dir, 'manifest.json'))
    print('  ✓ manifest.json 已写入（%d 个文件）' % len(files), flush=True)


if __name__ == '__main__':
    main()
