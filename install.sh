#!/usr/bin/env bash
# 明道中医层安装脚本：把本仓库的中医扩展装进一个 MINGDAO_HOME。
# 用法：MINGDAO_HOME=~/.mingdao-tcm bash install.sh
#      （不指定 MINGDAO_HOME 时默认 ~/.mingdao-tcm）
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${MINGDAO_HOME:-$HOME/.mingdao-tcm}"

echo "== 明道中医层安装 =="
echo "   目标 MINGDAO_HOME: $HOME_DIR"

# 品牌从「得一中医」改为「明道中医」，默认 MINGDAO_HOME 也随之从 ~/.deyi-tcm 改成 ~/.mingdao-tcm。
# 若你之前用的是旧默认目录，这里只**提示**、不自动迁移 —— 那里面有患者数据（patients.json /
# intake/），自动搬动出错的代价远大于手动搬一次。
if [ "$HOME_DIR" = "$HOME/.mingdao-tcm" ] && [ -d "$HOME/.deyi-tcm" ] && [ ! -d "$HOME/.mingdao-tcm" ]; then
  echo
  echo "   ⚠ 检测到旧目录 ~/.deyi-tcm（含患者数据）。默认目录已改为 ~/.mingdao-tcm。"
  echo "     要沿用旧数据，请显式指定：MINGDAO_HOME=~/.deyi-tcm bash install.sh"
  echo "     要迁到新默认：mv ~/.deyi-tcm ~/.mingdao-tcm   （或 cp -a 后确认无误再删）"
  echo
fi

# 1) 目录
mkdir -p "$HOME_DIR/providers" "$HOME_DIR/presets" "$HOME_DIR/packs"
chmod 700 "$HOME_DIR" 2>/dev/null || true

# 2) 安装垂域 Pack（v0.5.0+ 的正式接入方式：走扩展点，不改内核源码）
#    装到**用户级** $MINGDAO_HOME/packs/ —— 该位置自动发现，且不受「项目级 Pack 信任门」限制
#    （项目级 <repo>/.mingdao/packs/ 默认不挂载，需先 `mingdao pack trust <项目目录>`）。
if [ -d "$HERE/layer/packs" ]; then
  for d in "$HERE/layer/packs"/*/; do
    [ -f "$d/pack.json" ] || continue
    name="$(basename "$d")"
    ver="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$d/pack.json" | head -1)"
    rm -rf "$HOME_DIR/packs/$name"
    cp -R "$d" "$HOME_DIR/packs/$name"
    echo "   ✓ 已安装 Pack: $name v$ver"
  done
fi

# 3) 安装 Provider
#    路线 A（已定并已接线）：providers/dify.mjs 每轮先判「要不要调 Pack 工具」，
#    要调就交回内核执行，不调才走 Dify 流式问诊 —— 见 layer/packs/tcm/README.md 的「四、谁驱动问诊」一节。
#    （此处曾指向一个「待决策」小节：路线 A 定下来后那一节已改名，指向不存在的锚点比没有指引更糟。
#     现在 tools/doc-lint.mjs 的 INV-5 会校验 install.sh 引用的小节是否真的存在。）
cp "$HERE/layer/providers/"*.mjs "$HOME_DIR/providers/"
echo "   ✓ 已安装 Provider: $(cd "$HERE/layer/providers" && ls -1 *.mjs | tr '\n' ' ')"

# 3b) 装上 Pack 不是零影响，必须当场说清楚（否则会以为"没接线就等于没装"）
if [ -d "$HOME_DIR/packs/tcm" ]; then
  echo
  echo "   ⚠ 注意：Pack 已装好，其中「不作疗效结论」这条红线**立即生效**。"
  echo "     约束作用在 agent 正文上、与 provider 无关，所以**Dify 问诊的输出也被它管住了**："
  echo "     正文里出现结论性表述（治疗有效 / 已治愈 / 病情明显好转 …）时会**提示并写审计**，"
  echo "     但**不会替换掉正文** —— 正文是医师要看的，不能因为一个词就丢掉（2026-09-15 起由"
  echo "     block-and-rewrite 改为 warn，起因是医师实测反馈「已拦截」导致拿不到问诊结论）。"
  echo "     另外两条红线（缺 patientId / 主诉·现病史缺项）只作用于 Pack 自己的工具。"
  echo "     详见 layer/packs/tcm/README.md §二。"
fi

# 4) 预设（如有）
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
  2. 校验垂域 Pack（下游 CI 门禁，应退出 0）：
       mingdao pack verify $HOME_DIR/packs/tcm
     跑红线测试（需要一份内核检出）：
       MINGDAO_KERNEL=<MingDao-Harness 目录> node $HERE/layer/packs/tcm/test/pack.test.mjs
  3. 启动（在 MingDao-Harness 内核目录下）：
       MINGDAO_HOME=$HOME_DIR node src/cli.js web 3821
  4. 对话里试：
       患者张三，1985年生，首诊。<症状描述…>     # 首诊 → 分配病历号 + 落盘
       复诊：P001，<服药后变化…>                  # 复诊 → 四态对比
       回访                                        # 回访看板
       回访 P001                                   # 单患者随访（趋势+预警+话术）

数据位置（患者数据，勿入 git）：
  $HOME_DIR/patients.json      患者注册表（病历号）
  $HOME_DIR/intake/<病历号>/   病历快照
EOF
