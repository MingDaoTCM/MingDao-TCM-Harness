// 中医 Pack 的红线与工具契约测试。
//
// 运行（必须指向一份上游内核检出，测试要用它的**真实约束引擎**，而不是复刻一份）：
//   MINGDAO_KERNEL=/path/to/MingDao-Harness node layer/packs/tcm/test/pack.test.mjs
//
// 设计原则：**断言必须能失败**。每条红线都断言「确实被阻断」，而不是断言「声明了这条约束」——
// 后者在引擎坏掉/kind 写错时照样通过，是假绿。
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK_DIR = path.resolve(HERE, '..');
const KERNEL = process.env.MINGDAO_KERNEL || '';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${e?.message || e}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${e?.message || e}`); }
}

// ── 载入被测 Pack（用临时 home，绝不碰真实患者数据） ──
const TMP_HOME = path.join(process.env.TMPDIR || '/tmp', `tcm-pack-test-${process.pid}`);
const { createPack, matchPatient, missingFields, normalizeFields, visitLabel, daysSince, REQUIRED_FIELDS } =
  await import(path.join(PACK_DIR, 'pack.mjs'));

const pack = createPack({ home: TMP_HOME, packDir: PACK_DIR, packName: 'tcm', log: () => {} });

console.log('\n[1] 纯函数行为');
test('matchPatient：病历号精确命中', () => {
  const reg = { patients: { P001: { id: 'P001', name: '张三', birth: '1985', sex: '女' } } };
  assert.equal(matchPatient(reg, { id: 'p001' }).patient.id, 'P001');
});
test('matchPatient：同名多命中返回 ambiguous，不静默挑一个', () => {
  const reg = { patients: {
    P001: { id: 'P001', name: '张三', birth: '1985', sex: '女' },
    P002: { id: 'P002', name: '张三', birth: '1990', sex: '女' },
  } };
  const m = matchPatient(reg, { name: '张三' });
  assert.ok(m.ambiguous, '应返回 ambiguous');
  assert.equal(m.ambiguous.length, 2);
  assert.equal(m.patient, undefined, '绝不能在多命中时给出单个 patient');
});
test('matchPatient：姓名 + 出生年可收窄到唯一', () => {
  const reg = { patients: {
    P001: { id: 'P001', name: '张三', birth: '1985', sex: '女' },
    P002: { id: 'P002', name: '张三', birth: '1990', sex: '女' },
  } };
  assert.equal(matchPatient(reg, { name: '张三', birth: '1990' }).patient.id, 'P002');
});
test('missingFields：空串与「未提及」都算缺', () => {
  const f = normalizeFields({ zhushu: '失眠', zhenduan: '未提及', hanre: '' });
  const miss = missingFields(f);
  assert.ok(miss.includes('zhenduan'), '未提及应算缺');
  assert.ok(miss.includes('hanre'), '空串应算缺');
  assert.ok(!miss.includes('zhushu'), '有值不应算缺');
});
test('visitLabel：初诊/二诊/十一诊', () => {
  assert.equal(visitLabel(1), '初诊');
  assert.equal(visitLabel(2), '二诊');
  assert.equal(visitLabel(11), '第11诊');
});
test('daysSince：无效输入返回 null 而不抛错', () => {
  assert.equal(daysSince(''), null);
  assert.equal(daysSince('not-a-date'), null);
});

console.log('\n[2] 工具契约');
test('四个工具齐备且声明了正确读写属性', () => {
  const names = pack.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['followup_board', 'intake_collect', 'patient_lookup', 'visit_compare']);
  const ro = Object.fromEntries(pack.tools.map((t) => [t.name, t.readOnly]));
  assert.equal(ro.intake_collect, false, '落盘工具必须是写类（才进权限引擎的写判定）');
  assert.equal(ro.patient_lookup, true);
  assert.equal(ro.visit_compare, true);
  assert.equal(ro.followup_board, true);
});
test('intake_collect 的 schema 要求 patientId（模型侧第一道）', () => {
  const t = pack.tools.find((x) => x.name === 'intake_collect');
  assert.ok(t.parameters.required.includes('patientId'));
});
test('缺少 patientId 时工具自身也拒绝（约束之外的第二层）', async () => {
  const t = pack.tools.find((x) => x.name === 'intake_collect');
  const r = await t.run({ consultText: '主诉失眠' }, {});
  assert.equal(r.ok, false, '没有病历号必须拒绝');
});
test('提示词段非空且含三条红线关键词', () => {
  const s = pack.promptSections[0];
  assert.ok(s.content.length > 200, '提示词段不应为空');
  for (const kw of ['缺项绝不编造', '不输出诊疗结论', '不得跨患者串病历']) {
    assert.ok(s.content.includes(kw), `提示词段应含「${kw}」`);
  }
});

console.log('\n[3] 红线约束');
const cIds = pack.constraints.map((c) => c.id);
test('三条红线都已声明', () => {
  assert.ok(cIds.includes('no-cross-patient-intake'));
  assert.ok(cIds.includes('ten-questions-complete'));
  assert.ok(cIds.includes('no-efficacy-conclusion'));
});
test('completeness 覆盖全部十个必填字段', () => {
  const c = pack.constraints.find((x) => x.kind === 'completeness');
  assert.deepEqual(c.fields, REQUIRED_FIELDS);
  assert.equal(c.fields.length, 10);
});

if (!KERNEL) {
  console.log('\n[4] 真实引擎阻断验证 —— 已跳过');
  console.log('    未设置 MINGDAO_KERNEL；设成上游内核检出目录后重跑，这一步才会真正断言「被阻断」。');
} else {
  console.log(`\n[4] 真实引擎阻断验证（内核：${KERNEL}）`);
  const { compileConstraints, checkPreTool, checkPostTool, checkOutput } =
    await import(path.join(KERNEL, 'src', 'constraints.js'));

  // mountPacks 会给每条约束补 pack 名——测试里等价地补上，才能走到裸名匹配分支
  const withPack = pack.constraints.map((c) => ({ ...c, pack: 'tcm' }));
  const compiled = compileConstraints(withPack);
  const T = (bare) => `pack__tcm__${bare}`;

  test('引擎编译后无非法条目（pattern 写错会被装载期拦下）', () => {
    assert.equal(compiled.invalid.length, 0, `非法约束：${compiled.invalid.join('、')}`);
  });

  test('红线一 · 缺 patientId 的写操作被 PreToolUse 阻断', () => {
    const v = checkPreTool(compiled, T('intake_collect'), { consultText: '主诉失眠' });
    assert.ok(v?.blocked, '缺 patientId 必须被阻断');
  });
  test('红线一 · 带 patientId 时放行（约束只拦该拦的）', () => {
    const v = checkPreTool(compiled, T('intake_collect'), { patientId: 'P001', consultText: '主诉失眠' });
    assert.ok(!v?.blocked, '带了病历号不应被拦');
  });

  test('红线二 · 十问缺项的结果被 PostToolUse 拒绝', () => {
    const partial = Object.fromEntries(REQUIRED_FIELDS.map((k) => [k, k === 'zhushu' ? '失眠' : '']));
    const v = checkPostTool(compiled, T('intake_collect'), { ok: true, output: '...', data: partial });
    assert.ok(v?.rejected, '缺项结果必须被拒绝');
    assert.ok(v.missing.length >= 1);
  });
  test('红线二 · 十项齐全的结果放行', () => {
    const full = Object.fromEntries(REQUIRED_FIELDS.map((k) => [k, `${k}-值`]));
    const v = checkPostTool(compiled, T('intake_collect'), { ok: true, output: '...', data: full });
    assert.ok(!v?.rejected, '齐全不应被拒绝');
  });

  // 注意：checkOutput 的返回字段是 `hit`（不是 blocked/rejected），与 Pre/PostToolUse 不同名。
  test('红线三 · 输出含「好转」被 output-forbid 拦下', () => {
    const v = checkOutput(compiled, '本次服药后患者病情好转，继续原方。');
    assert.ok(v?.hit, '疗效结论必须被拦下');
    assert.equal(v.matched, '好转', '应命中「好转」本身');
    assert.equal(v.action, 'block-and-rewrite', 'action 必须与 Pack 里声明的一致');
  });
  test('红线三 · 「有效」「治愈」同样被拦', () => {
    for (const w of ['有效', '治愈']) {
      const v = checkOutput(compiled, `评估：该方${w}。`);
      assert.ok(v?.hit, `「${w}」必须被拦下`);
    }
  });
  test('红线三 · 纯事实输出放行', () => {
    const v = checkOutput(compiled, '本次主诉失眠，较上次入睡时间提前，二便正常。');
    assert.ok(!v?.hit, '纯事实陈述不应被拦');
  });
  test('红线三 · 既往确诊事实不被误伤（「确诊为」刻意不在 pattern 内）', () => {
    const v = checkOutput(compiled, '既往 2024 年确诊为宫颈癌，现术后随访。');
    assert.ok(!v?.hit, '重大疾病诊断必须能原样输出——这正是不把「确诊为」写进 pattern 的原因');
  });
}

// 收尾：清掉临时 home（测试全程不写真实 MINGDAO_HOME）
try { const fs = await import('node:fs'); fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}

console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
