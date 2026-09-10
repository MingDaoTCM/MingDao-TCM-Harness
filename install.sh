#!/usr/bin/env bash
# 得一中医层安装脚本：把本仓库的中医扩展装进一个 MINGDAO_HOME。
# 用法：MINGDAO_HOME=~/.deyi-tcm bash install.sh
#      （不指定 MINGDAO_HOME 时默认 ~/.deyi-tcm）
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${MINGDAO_HOME:-$HOME/.deyi-tcm}"

echo "== 得一中医层安装 =="
echo "   目标 MINGDAO_HOME: $HOME_DIR"

# 1) 目录
mkdir -p "$HOME_DIR/providers" "$HOME_DIR/presets"
chmod 700 "$HOME_DIR" 2>/dev/null || true

# 2) 安装 Provider（覆盖更新，代码可重复安装）
cp "$HERE/layer/providers/"*.mjs "$HOME_DIR/providers/"
echo "   ✓ 已安装 Provider: $(ls -1 "$HERE/layer/providers/" | tr '\n' ' ')"

# 3) 预设（如有）
if ls "$HERE/layer/presets/"*.json >/dev/null 2>&1; then
  cp "$HERE/layer/presets/"*.json "$HOME_DIR/presets/"
  echo "   ✓ 已安装预设"
fi

# 4) config.json（不覆盖已有）
if [ ! -f "$HOME_DIR/config.json" ]; then
  cp "$HERE/examples/config.example.json" "$HOME_DIR/config.json"
  echo "   ✓ 已生成 config.json（示例配置）"
else
  echo "   · config.json 已存在，保留不覆盖"
fi

# 5) credentials.json（不覆盖已有；只生成模板）
if [ ! -f "$HOME_DIR/credentials.json" ]; then
  cat > "$HOME_DIR/credentials.json" <<'JSON'
{
  "dify": "app-在此填入你的 Dify App API Key",
  "deepseek": "sk-在此填入你的 DeepSeek API Key"
}
JSON
  chmod 600 "$HOME_DIR/credentials.json"
  echo "   ✓ 已生成 credentials.json 模板（记得填密钥）"
else
  echo "   · credentials.json 已存在，保留不覆盖"
fi

cat <<EOF

== 安装完成 ==
下一步：
  1. 填密钥：编辑 $HOME_DIR/credentials.json（dify + deepseek）
  2. 启动（在 MingDao-Harness 内核目录下）：
       MINGDAO_HOME=$HOME_DIR node src/cli.js web 3821
  3. 对话里试：
       患者张三，1985年生，首诊。<症状描述…>     # 首诊 → 分配病历号 + 落盘
       复诊：P001，<服药后变化…>                  # 复诊 → 四态对比
       回访                                        # 回访看板
       回访 P001                                   # 单患者随访（趋势+预警+话术）

数据位置（患者数据，勿入 git）：
  $HOME_DIR/patients.json      患者注册表（病历号）
  $HOME_DIR/intake/<病历号>/   病历快照
EOF
