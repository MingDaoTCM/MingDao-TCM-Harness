# 明道中医 · 问诊台 —— 内部站点（tcm.mingdao.ai）

**不公开**的产品站：首页要密码才能进，密码可在后台改，安装包登录后才能下载。
部署在**与官网同一台服务器**上（同一套 openresty 容器），但完全不碰官网的站点目录与配置。

## 它长在哪

```
浏览器 ──https──▶ tcm.mingdao.ai
                     │  openresty 容器（1Panel，host 网络）
                     │  /opt/1panel/www/conf.d/tcm.conf      ← vhost（本仓库 site/nginx/tcm.conf）
                     └─▶ 127.0.0.1:8448
                          mingdao-tcm-site.service           ← 宿主 node（本仓库 site/server.mjs）
                          /opt/1panel/www/sites/tcm-site/    ← 站点文件 + downloads/
                          /var/lib/mingdao-tcm-site/         ← 密码哈希与会话密钥（0600）
```

官网（harness.mingdao.ai）是**静态直出**；本站是**动态**的 —— 密码门 / 改密码 / 安装包鉴权下载都是
Node 服务做的，所以 vhost 只做反向代理。端口选 8448：8443/8445/8446/8447 已被官网的同步/论坛/信标占用。

## 密码门怎么设计的

| 事项 | 做法 |
|---|---|
| 密码存储 | **scrypt 哈希**（不存明文、不可逆）；比对用 `timingSafeEqual` |
| 会话 | **HMAC 签名**的无状态 cookie（服务端不存 session，重启不掉线），HttpOnly + Secure + SameSite=Lax |
| 两把钥匙 | **访问密码**（进门看站）与**管理员密码**（进 `/admin`）分开；初始两者相同，部署后请立刻改掉 |
| 改密码 | 后台改，**立即生效**；改密会轮换会话密钥 → **所有旧会话当场吊销** |
| 爆破防护 | 同一 IP 10 分钟内失败 8 次即 429 |
| 下载 | `/downloads/<文件>` 必须已登录，否则 302 回登录页；路径做白名单（挡 `../` 与软链逃逸） |
| 支持 Range | 100MB 级安装包支持断点续传 |

> **无状态会话的取舍**：服务端不存 session，所以「改密码吊销旧会话」是靠**轮换签名密钥**实现的
> （一次性吊销全部），而不是逐个失效。对「一把门钥匙」这个规模是合适的。
>
> 改**访问**密码时会顺手给当前管理员续一条新 cookie —— 否则管理员改完自己的门钥匙反倒把自己锁在外面。

## 发布

```bash
bash site/deploy.sh            # 用最新 GitHub Release
bash site/deploy.sh v0.1.1     # 指定版本
```

脚本会：拉安装包（私有仓库，用 `MINGDAO_GITHUB_TOKEN`）→ 算 sha256、生成
`downloads/manifest.json` → 上传站点/服务/单元/vhost → 首次用 acme.sh 签证书（分两阶段：
先只开 80 过 ACME、再上 443）→ 重启服务、reload openresty → 自检首页是否返回登录页。

**幂等**：重复跑只覆盖文件与重启服务；证书已存在不重签；**不会动密码**（`auth.json` 在数据目录里）。

## 后台

- 地址：`https://tcm.mingdao.ai/admin`（用**管理员密码**）
- 能改：访问密码、管理员密码（改完立即生效）
- 首次部署的初始密码：服务只在生成那次把它打进日志，同时写到
  `/var/lib/mingdao-tcm-site/INITIAL-PASSWORD.txt`（0600）。`deploy.sh` 首次会把日志里那行带出来。
  **改完密码请删掉那个文件。**

## 本地开发 / 测试

```bash
node site/server.mjs                                  # 默认 8448，需 TCM_ROOT/TCM_DATA
TCM_ROOT=site/public TCM_DATA=/tmp/tcm-data TCM_INIT_PASSWORD=dev123 node site/server.mjs
node site/test/site.test.mjs                          # 端到端（19 项）：真起进程跑完整流程
```

测试覆盖的是这个站**全部的价值点**：没密码进不来、改密码真的生效（旧密码失效 + 旧会话吊销）、
下载要登录、路径穿越拿不到源码、凭据文件 0600 且不含明文。

```bash
bash tools/tcm-ui/desktop/build/make-icons.sh         # 改图标后重新生成（SVG → 各尺寸 PNG）
```

## 文件

| 文件 | 说明 |
|---|---|
| `server.mjs` | 站点服务（零依赖单文件）：密码门 / 会话 / 后台 / 鉴权下载 |
| `public/login.html` | 登录页 |
| `public/index.html` | 首页（下载卡从 `/api/downloads` 渲染，不写死文件名） |
| `public/assets/icon.png`、`favicon.ico`、`apple-touch-icon.png` | 站点图标（与桌面版同源） |
| `nginx/tcm.conf` | openresty vhost（→ `/opt/1panel/www/conf.d/tcm.conf`） |
| `systemd/mingdao-tcm-site.service` | systemd 单元 |
| `deploy.sh` | 发布脚本 |
| `test/site.test.mjs` | 端到端测试 |
