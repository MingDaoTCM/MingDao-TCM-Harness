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
import re
import sys
import time
import urllib.request
import datetime

KEEP = ('.exe', '.dmg', '.zip', '.AppImage', '.deb')


# 自动更新元数据（electron-builder 生成的 latest*.yml）：要随包一起上站点，
# 但**不进页面清单**（它不是给人点的安装包）。
def is_update_meta(name):
    return bool(re.match(r'^latest.*\.ya?ml$', name))


def is_installer(name):
    """macOS 打包会留下 AppleDouble 资源叉（`._xxx.dmg`），同样以 .dmg 结尾 ——
    它不是安装包，混进清单只会让页面多出 0 字节的按钮。"""
    return name.endswith(KEEP) and not name.startswith('._')


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
    ap.add_argument('--repo', default='', help='owner/name；--manifest-only 时不需要')
    ap.add_argument('--tag', required=True)
    ap.add_argument('--dir', required=True)
    ap.add_argument('--token-stdin', action='store_true')
    ap.add_argument('--token-file', help='读这个文件里的 token，**读完立即 unlink**')
    ap.add_argument('--manifest-only', action='store_true',
                    help='不下载，只按当前 downloads/ 目录里的文件重算 manifest.json（CI 推完包后跑这个）')
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
    if not token and not a.manifest_only:  # --manifest-only 只算哈希，不需要 token
        raise SystemExit('缺少 token（--token-file / --token-stdin / GH_TOKEN）')

    # 安装包不可能小于这个体积（最小的 Windows 包也有 ~70MB）。
    # 低于它只可能是**传了一半**的文件 —— 2026-09-30 实测踩到：被取消的构建在站点上
    # 留下 4 个半截文件（"deb" 只有 4.6MB），而清单照样把它们列成可下载的安装包
    # → 医师下到的是坏包。宁可**拒绝写清单**（页面显示"尚未上传"），也不要提供坏包。
    MIN_INSTALLER_BYTES = 1 << 20

    def expected_sizes(tag, token):
        """从 GitHub Release 取 {文件名: 字节数}，用于**精确对账**。
        为什么不只靠"文件太小"判断：半截文件可能有好几 MB（实测 4.6MB 的"deb"），
        粗阈值拦不住；Release 上的大小才是唯一权威。取不到就返回 None（退化为粗检）。"""
        if not a.repo or not token:
            return None
        try:
            rel = json.load(api('https://api.github.com/repos/%s/releases/tags/%s' % (a.repo, tag), token))
            # 只与**本站点该有的**资产对账：zip 是自动更新用的，站点按设计不推它们（页面也不展示），
            # 若把 zip 也算进来，会永远判定"缺文件"→ 拒绝写清单 → 页面空白。
            # 2026-10-01 实测踩到：v0.1.9 五个包都传上去了，清单却因为这条一直不生成。
            return {x['name']: x['size'] for x in rel.get('assets', [])
                    if is_installer(x['name']) or is_update_meta(x['name'])}
        except Exception as e:  # noqa: BLE001 —— 取不到不该挡住写清单（会退化为粗检并告警）
            print('  ! 取 Release 资产大小失败（退化为粗检）：%s' % e, flush=True)
            return None

    def main_manifest_only(tag, d, token=''):
        ver = tag.lstrip('v')
        want = expected_sizes(tag, token)
        # ① 清掉 AppleDouble 垃圾（macOS 打包副产物）与**其它版本**的残留。
        #    别的版本的半截文件留着毫无用处，而它们会被下面的扫描当成"本站点的包"。
        dropped = []
        for n in list(os.listdir(d)):
            if n == 'manifest.json':
                continue
            stale = n.startswith('._') or ((is_installer(n) or is_update_meta(n)) and ver not in n and not is_update_meta(n))
            if stale:
                try:
                    os.unlink(os.path.join(d, n))
                    dropped.append(n)
                except OSError:
                    pass
        for n in dropped:
            print('  ✗ 清掉不属于本版本/垃圾文件：%s' % n, flush=True)

        # ② 精确对账：与 Release 上的大小不一致 = 传了一半，**拒绝写清单**
        #    （页面于是显示"尚未上传"，而不是提供一个装不上的包）
        if want is not None:
            for n in sorted(os.listdir(d)):
                if is_installer(n) and n not in want:
                    raise SystemExit('%s 不在 Release %s 的资产里 —— 拒绝写清单' % (n, tag))
            missing = [n for n in want if not os.path.exists(os.path.join(d, n))]
            if missing:
                raise SystemExit('站点缺少 Release 里的：%s —— 拒绝写清单' % ', '.join(missing))

        files = []
        for n in sorted(os.listdir(d)):
            if not (is_installer(n) or is_update_meta(n)):
                continue
            if is_update_meta(n) or n.endswith('.zip'):
                continue          # 更新元数据与 zip 只校验存在与大小，**不进页面清单**（页面只给人点安装包）
            p = os.path.join(d, n)
            size = os.path.getsize(p)
            if want is not None and size != want[n]:
                raise SystemExit('%s 大小 %d 与 Release 的 %d 不符 —— 像是传了一半，拒绝写清单'
                                 % (n, size, want[n]))
            if size < MIN_INSTALLER_BYTES:
                raise SystemExit('%s 只有 %d 字节（< %d）—— 像是传了一半，拒绝写清单'
                                 % (n, size, MIN_INSTALLER_BYTES))
            files.append({'name': n, 'size': size, 'sha256': sha256(p)})
        if not files:
            raise SystemExit('downloads/ 里没有安装包，拒绝写空清单')
        manifest = {
            'version': tag.lstrip('v'),
            'generatedAt': datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
            'files': files,
        }
        tmp = os.path.join(d, '.manifest.json.tmp')
        with open(tmp, 'w') as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        os.replace(tmp, os.path.join(d, 'manifest.json'))
        print('  ✓ manifest.json 已重算（%d 个文件）' % len(files), flush=True)

    if a.manifest_only:
        main_manifest_only(a.tag, a.dir, token)
        return

    if not a.repo:
        raise SystemExit('缺少 --repo（owner/name）')
    os.makedirs(a.dir, exist_ok=True)
    rel = json.load(api('https://api.github.com/repos/%s/releases/tags/%s' % (a.repo, a.tag), token))
    assets = [x for x in rel.get('assets', []) if is_installer(x['name'])]
    if not assets:
        raise SystemExit('Release %s 没有可发布的安装包' % a.tag)
    print('  共 %d 个安装包' % len(assets), flush=True)

    # 只保留本版本的包：多个版本混在一个目录里时，清单会把它们全列出来
    # （页面上同时出现 0.1.2 / 0.1.3，医师不知道下哪个）。下之前先清掉不属于本次 release 的。
    keep_names = set(x['name'] for x in assets)
    for old in os.listdir(a.dir):
        if old in keep_names or old == 'manifest.json':
            continue
        if is_installer(old) or old.startswith('._'):
            try:
                os.unlink(os.path.join(a.dir, old))
                print('  ✗ 清掉旧版本：%s' % old, flush=True)
            except OSError:
                pass
    try:
        os.unlink(os.path.join(a.dir, 'manifest.json'))
    except OSError:
        pass

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
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
        'files': sorted(files, key=lambda f: f['name']),
    }
    tmp = os.path.join(a.dir, '.manifest.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    os.replace(tmp, os.path.join(a.dir, 'manifest.json'))
    print('  ✓ manifest.json 已写入（%d 个文件）' % len(files), flush=True)


if __name__ == '__main__':
    main()
