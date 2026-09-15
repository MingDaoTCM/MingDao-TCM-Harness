// 中医 Pack 的红线与工具契约测试。
//
// 运行（必须指向一份上游内核检出，测试要用它的**真实约束引擎**，而不是复刻一份）：
//   MINGDAO_KERNEL=/path/to/MingDao-Harness node layer/packs/tcm/test/pack.test.mjs
//
// 设计原则：**断言必须能失败**。每条红线都断言「确实被阻断」，而不是断言「声明了这条约束」——
// 后者在引擎坏掉/kind 写错时照样通过，是假绿。
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  const f = normalizeFields({ zhushu: '失眠', xianbingshi: '未提及', jiwangshi: '' });
  const miss = missingFields(f);
  assert.ok(miss.includes('xianbingshi'), '未提及应算缺');
  assert.ok(!miss.includes('jiwangshi'), '可选字段为空**不算缺**（否则会把可选当必填）');
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
test('五个工具齐备且声明了正确读写属性', () => {
  const names = pack.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['followup_board', 'intake_collect', 'patient_lookup', 'patient_register', 'visit_compare']);
  const ro = Object.fromEntries(pack.tools.map((t) => [t.name, t.readOnly]));
  assert.equal(ro.intake_collect, false, '落盘工具必须是写类（才进权限引擎的写判定）');
  assert.equal(ro.patient_register, false, '登记新患者会改注册表，必须是写类');
  assert.equal(ro.patient_lookup, true, '定位患者不得写任何东西');
  assert.equal(ro.visit_compare, true);
  assert.equal(ro.followup_board, true);
});
test('intake_collect 的 schema 要求 patientId（模型侧第一道）', () => {
  const t = pack.tools.find((x) => x.name === 'intake_collect');
  assert.ok(t.parameters.required.includes('patientId'));
});
await testAsync('缺少 patientId 时工具自身也拒绝（约束之外的第二层）', async () => {
  const t = pack.tools.find((x) => x.name === 'intake_collect');
  const r = await t.run({ consultText: '主诉失眠' }, {});
  assert.equal(r.ok, false, '没有病历号必须拒绝');
});
test('提示词段非空且含三条红线关键词', () => {
  const s = pack.promptSections[0];
  assert.ok(s.content.length > 200, '提示词段不应为空');
  for (const kw of ['缺项绝不编造', '不作疗效结论', '不得跨患者串病历']) {
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
test('completeness 只覆盖两项必填：主诉 + 现病史', () => {
  const c = pack.constraints.find((x) => x.kind === 'completeness');
  assert.deepEqual(c.fields, REQUIRED_FIELDS);
  assert.deepEqual(c.fields, ['zhushu', 'xianbingshi']);
  for (const opt of ['jiwangshi', 'jiazushi', 'guominshi', 'liuxingbingshi', 'tigejiancha', 'shexiang', 'maixiang', 'suifang']) {
    assert.ok(!c.fields.includes(opt), `${opt} 是可选，不得进必填红线`);
  }
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

  test('红线二 · 必填缺项的结果被 PostToolUse 拒绝', () => {
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
  test('红线三 · **结论性**表述被命中（action=warn：提示并记审计，不替换正文）', () => {
    const v = checkOutput(compiled, '本次服药后病情明显好转，继续原方。');
    assert.ok(v?.hit, '结论性表述必须被命中');
    assert.equal(v.action, 'warn', 'action 必须是 warn —— 正文是医师要看的，不能因为一个词就丢掉');
  });
  test('红线三 · 「治疗有效」「已治愈」被命中', () => {
    for (const w of ['治疗有效', '已治愈']) {
      const v = checkOutput(compiled, `评估：${w}。`);
      assert.ok(v?.hit, `「${w}」必须被命中`);
      assert.equal(v.action, 'warn');
    }
  });
  test('红线三 · ★ 事实转述放行（「自述服药后好转」不该被拦——它是事实，不是结论）', () => {
    const v = checkOutput(compiled, '患者自述服药后好转，睡眠较前改善。');
    assert.ok(!v?.hit, '临床记录里的事实转述必须放行，否则医师会拿不到正文');
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

// ─────────────────────────────────────────────────────────────
// [5] 工具功能：用临时 home + 桩 llm 跑一遍真实业务流。
//     这一段刻意不碰真实 MINGDAO_HOME —— 它写的是 TMP_HOME。
// ─────────────────────────────────────────────────────────────
console.log('\n[5] 工具功能（临时 home + 桩 llm）');

const tool = (bare) => pack.tools.find((x) => x.name === bare);
const F = {
  zhushu: '失眠多梦三个月',
  xianbingshi: '三月前无诱因出现入睡困难，伴多梦易醒；既往 2024 年确诊为宫颈癌，术后规律复查；未系统治疗失眠。',
  jiwangshi: '宫颈癌术后；高血压十年',
  jiazushi: '母亲有高血压',
  guominshi: '青霉素过敏',
  liuxingbingshi: '否认疫区接触',
  tigejiancha: 'T 36.5℃ P 78次/分 R 18次/分 BP 138/86mmHg',
  shexiang: '舌红苔黄',
  maixiang: '脉弦细',
  suifang: '两周后复诊；嘱记录睡眠日记',
};
/** 桩：按 purpose 返回预设结构化结果（不联网、行为可控） */
const stub = (replies) => ({ llm: async ({ purpose }) => ({ data: replies[purpose] ?? null }) });
const snapshotFiles = (pid) => {
  try { return fs.readdirSync(path.join(TMP_HOME, 'intake', pid)).filter((f) => f.endsWith('.json')); } catch { return []; }
};
const registry = () => JSON.parse(fs.readFileSync(path.join(TMP_HOME, 'patients.json'), 'utf8'));

await testAsync('patient_lookup：空库里的一手资料 → new（不建人）', async () => {
  const r = await tool('patient_lookup').run({ text: '患者张三，1985年生，女，失眠多梦' },
    stub({ 'patient-extract': { id: '', name: '张三', birth: '1985', sex: '女' } }));
  assert.equal(r.data.status, 'new');
  assert.ok(!fs.existsSync(path.join(TMP_HOME, 'patients.json')), '只读工具不得写注册表');
});

await testAsync('intake_collect：病历号不存在 → 拒绝落盘', async () => {
  const r = await tool('intake_collect').run({ patientId: 'P999', consultText: '主诉失眠' }, stub({}));
  assert.equal(r.ok, false);
  assert.equal(snapshotFiles('P999').length, 0);
});

await testAsync('patient_register：登记新患者并分配病历号 P001', async () => {
  const r = await tool('patient_register').run({ name: '张三', birth: '1985', sex: '女' }, stub({}));
  assert.equal(r.ok, true);
  assert.equal(r.data.patientId, 'P001');
  assert.equal(registry().patients.P001.name, '张三');
});

await testAsync('patient_register：同名已存在 → 拒绝重复登记（避免混病历）', async () => {
  const r = await tool('patient_register').run({ name: '张三' }, stub({}));
  assert.equal(r.ok, false, '同名必须拒绝登记');
  assert.ok(String(r.error).includes('P001'), '错误里应指出已有的病历号');
});

await testAsync('intake_collect：必填缺项 → 不落盘（半份病历比没有更危险）', async () => {
  const partial = { complete: false, ...F, zhushu: '', xianbingshi: '' };
  const r = await tool('intake_collect').run({ patientId: 'P001', consultText: '主诉失眠' },
    stub({ 'intake-extract': partial }));
  assert.equal(snapshotFiles('P001').length, 0, '缺项时绝不能落盘');
  assert.ok(r.data && typeof r.data === 'object', '仍要交出 data，让内核 completeness 约束再拦一次');
  assert.equal(registry().patients.P001.visits || 0, 0, '未落盘就不得计入就诊次数');
});

await testAsync('intake_collect：必填齐全 → 落盘 + 注册表更新 + source 标记', async () => {
  const r = await tool('intake_collect').run({ patientId: 'P001', consultText: '首诊全文' },
    stub({ 'intake-extract': { complete: true, ...F } }));
  assert.equal(r.ok, true);
  assert.equal(snapshotFiles('P001').length, 1);
  assert.ok(String(r.output).includes('已落盘'));
  const reg = registry();
  assert.equal(reg.patients.P001.visits, 1);
  assert.ok(reg.patients.P001.lastVisitAt, '末次就诊时间必须更新');
  const snap = JSON.parse(fs.readFileSync(path.join(TMP_HOME, 'intake', 'P001', snapshotFiles('P001')[0]), 'utf8'));
  assert.equal(snap.xianbingshi, F.xianbingshi, '重大疾病诊断（宫颈癌）必须原样落盘');
  assert.equal(snap.source, 'tcm-pack');
  assert.equal(snap.patientId, 'P001');
});

await testAsync('patient_lookup：已有患者 → found，且给出本次为第 2 次就诊', async () => {
  const r = await tool('patient_lookup').run({ name: '张三' }, stub({}));
  assert.equal(r.data.status, 'found');
  assert.equal(r.data.visitNo, 2);
  assert.equal(r.data.visitLabel, '二诊');
});

await testAsync('visit_compare：只有一次就诊 → 明确说明无法对比', async () => {
  const r = await tool('visit_compare').run({ patientId: 'P001' }, stub({}));
  assert.equal(r.ok, true);
  assert.ok(String(r.output).includes('无法做复诊对比'));
});

await testAsync('完整复诊：落盘第二份 → 四态对比 → 注册表 visits=2', async () => {
  const rc = await tool('intake_collect').run({ patientId: 'P001', consultText: '复诊全文' },
    stub({ 'intake-extract': { complete: true, ...F, han: '盗汗已止' } }));
  assert.equal(rc.ok, true);
  assert.equal(snapshotFiles('P001').length, 2);
  assert.equal(registry().patients.P001.visits, 2);

  const rv = await tool('visit_compare').run({ patientId: 'P001' },
    stub({ 'visit-compare': { items: [{ label: '汗', last: '夜间盗汗', now: '盗汗已止', state: '减轻' }] } }));
  assert.ok(String(rv.output).includes('复诊四态对比'));
  assert.ok(String(rv.output).includes('减轻'));
  assert.equal(rv.data.items.length, 1);
});

await testAsync('followup_board：看板列出患者与就诊次数', async () => {
  const r = await tool('followup_board').run({}, stub({}));
  assert.ok(String(r.output).includes('回访看板'));
  assert.ok(String(r.output).includes('P001'));
  assert.equal(r.data.total, 1);
});

await testAsync('followup_board：单患者随访带出趋势/预警/话术', async () => {
  const r = await tool('followup_board').run({ patientId: 'P001' },
    stub({ 'followup-script': { trend: '入睡时间逐次提前', alerts: ['超期未复诊'], script: '张阿姨您好…' } }));
  assert.ok(String(r.output).includes('时间线趋势'));
  assert.ok(String(r.output).includes('异常预警'));
  assert.ok(String(r.output).includes('草稿·需医师确认'));
});

await testAsync('同名多命中：patient_lookup 返回候选列表、不替你挑一个', async () => {
  await tool('patient_register').run({ name: '李四', birth: '1970', sex: '男' }, stub({}));
  await tool('patient_register').run({ name: '李四', birth: '1990', sex: '男' }, stub({}));
  const r = await tool('patient_lookup').run({ name: '李四' }, stub({}));
  assert.equal(r.data.status, 'ambiguous');
  assert.equal(r.data.candidates.length, 2);
  assert.equal(r.data.patient, undefined, '多命中时绝不能给出单个患者');
  assert.ok(String(r.output).includes('请确认是哪位'));
});

await testAsync('工具报错不抛异常（AI SDK 的容错约定）', async () => {
  for (const t of pack.tools) {
    const r = await t.run({}, stub({}));
    assert.ok(r && typeof r === 'object', `${t.name} 必须返回对象而不是抛错`);
  }
});

// ─────────────────────────────────────────────────────────────
// [6] 错误路径：患者数据是医疗记录，「失败」必须比「静默给错结果」优先。
// ─────────────────────────────────────────────────────────────
console.log('\n[6] 错误路径与降级（独立临时 home）');

const HOME2 = path.join(process.env.TMPDIR || '/tmp', `tcm-err-test-${process.pid}`);
const freshPack = () => {
  fs.rmSync(HOME2, { recursive: true, force: true });
  fs.mkdirSync(HOME2, { recursive: true });
  return createPack({ home: HOME2, packDir: PACK_DIR, packName: 'tcm', log: () => {} });
};
const file = (p) => path.join(HOME2, p);
const seedSnapshot = (pid) => {
  fs.mkdirSync(file(path.join('intake', pid)), { recursive: true });
  fs.writeFileSync(file(path.join('intake', pid, 'case-1.json')), JSON.stringify({ patientId: pid, zhushu: '旧患者主诉' }));
};

await testAsync('注册表根本不存在 → 正常（全新 home 应从 P001 开始）', async () => {
  const p = freshPack();
  const r = await p.tools.find((t) => t.name === 'patient_register').run({ name: '首位患者' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.data.patientId, 'P001');
});

await testAsync('★ 注册表 JSON 损坏 → 拒绝操作，绝不静默从 P001 重新发号', async () => {
  const p = freshPack();
  seedSnapshot('P001'); // 盘上已有 P001 的病历
  fs.writeFileSync(file('patients.json'), '{"nextId":2,"patients":{"P001":{"id":"P001","na'); // 半写/截断
  const r = await p.tools.find((t) => t.name === 'patient_register').run({ name: '新患者', birth: '1990', sex: '男' }, {});
  assert.notEqual(r.ok, true, '注册表损坏时绝不能报成功');
  assert.ok(/损坏|无法读取|结构不符/.test(String(r.error)), `错误应说明原因，实际：${r.error}`);
  assert.ok(/备份|修复/.test(String(r.error)), '错误应给出可操作的建议');
  assert.equal(r.data, undefined, '不得返回任何病历号');
});

await testAsync('★ 注册表损坏时只读工具同样拒绝（不把「读不出来」伪装成「没有患者」）', async () => {
  const p = freshPack();
  seedSnapshot('P001');
  fs.writeFileSync(file('patients.json'), 'not json at all');
  const r = await p.tools.find((t) => t.name === 'followup_board').run({}, {});
  assert.notEqual(r.ok, true, '看板不能显示成「0 位患者」——那会让人以为数据没了');
  const r2 = await p.tools.find((t) => t.name === 'patient_lookup').run({ name: '张三' }, {});
  assert.notEqual(r2.data?.status, 'new', '不能因为读不出注册表就把老患者判成新患者');
});

await testAsync('注册表结构不符（patients 不是对象）→ 拒绝', async () => {
  const p = freshPack();
  fs.writeFileSync(file('patients.json'), JSON.stringify({ nextId: 1, patients: [] }));
  const r = await p.tools.find((t) => t.name === 'patient_register').run({ name: '张三' }, {});
  assert.notEqual(r.ok, true);
  assert.ok(/结构不符/.test(String(r.error)));
});

await testAsync('★ 独立兜底：nextId 被改小、盘上已有 P001 → 跳过 P001 而不是复用', async () => {
  const p = freshPack();
  seedSnapshot('P001');
  seedSnapshot('P002');
  // 注册表里没有任何患者记录，nextId 还停在 1（模拟注册表被回滚/替换）
  fs.writeFileSync(file('patients.json'), JSON.stringify({ nextId: 1, patients: {} }));
  const r = await p.tools.find((t) => t.name === 'patient_register').run({ name: '新患者' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.data.patientId, 'P003', `必须跳过盘上已有的 P001/P002，实际给了 ${r.data.patientId}`);
});

await testAsync('ctx.llm 不可用 → 明确报错且不落盘（不假装成功）', async () => {
  const p = freshPack();
  await p.tools.find((t) => t.name === 'patient_register').run({ name: '张三' }, {});
  const r = await p.tools.find((t) => t.name === 'intake_collect').run({ patientId: 'P001', consultText: '首诊' }, {});
  assert.notEqual(r.ok, true, 'llm 不可用时必须失败');
  assert.equal(fs.existsSync(file(path.join('intake', 'P001'))), false, '不得落盘');
});

await testAsync('模型返回非 JSON → 明确报错且不落盘', async () => {
  const p = freshPack();
  await p.tools.find((t) => t.name === 'patient_register').run({ name: '张三' }, {});
  const r = await p.tools.find((t) => t.name === 'intake_collect').run({ patientId: 'P001', consultText: '首诊' },
    { llm: async () => ({ data: null, text: '抱歉，我无法解析。' }) });
  assert.notEqual(r.ok, true);
  assert.equal(fs.existsSync(file(path.join('intake', 'P001'))), false, '不得落盘');
});

await testAsync('缺项补齐后可正常落盘（不因一次缺项就永久卡死）', async () => {
  const p = freshPack();
  await p.tools.find((t) => t.name === 'patient_register').run({ name: '张三' }, {});
  const miss = await p.tools.find((t) => t.name === 'intake_collect').run({ patientId: 'P001', consultText: '只说了一半' },
    { llm: async () => ({ data: { complete: false, ...F, xianbingshi: '' } }) });
  assert.equal(fs.existsSync(file(path.join('intake', 'P001'))), false, '缺项时不应落盘');
  assert.ok(String(miss.output).includes('继续'), '应提示继续采集');
  const okRes = await p.tools.find((t) => t.name === 'intake_collect').run({ patientId: 'P001', consultText: '补齐了' },
    { llm: async () => ({ data: { complete: true, ...F } }) });
  assert.equal(okRes.ok, true, '补齐后必须能落盘');
  assert.equal(fs.readdirSync(file(path.join('intake', 'P001'))).filter((f) => f.endsWith('.json')).length, 1);
});

await testAsync('可选字段（舌象/脉象）：采集到就落盘，缺了**不影响**落盘', async () => {
  const p = freshPack();
  await p.tools.find((t) => t.name === 'patient_register').run({ name: '王五' }, {});
  // ① 必填齐全但**没有**舌象/脉象 → 必须照样落盘（否则基层场景记不了病历）
  const requiredOnly = { zhushu: F.zhushu, xianbingshi: F.xianbingshi };
  const r1 = await p.tools.find((t) => t.name === 'intake_collect').run({ patientId: 'P001', consultText: '首诊' },
    { llm: async () => ({ data: { complete: true, ...requiredOnly } }) });
  assert.equal(r1.ok, true, '可选字段缺失不得挡住落盘');
  const f1 = fs.readdirSync(file(path.join('intake', 'P001'))).filter((x) => x.endsWith('.json'));
  assert.equal(f1.length, 1);
  const s1 = JSON.parse(fs.readFileSync(file(path.join('intake', 'P001', f1[0])), 'utf8'));
  assert.equal(s1.shexiang, '', '未采集到就留空串，不得编造');
  assert.equal(s1.maixiang, '');

  // ② 采集到舌象/脉象 → 必须原样落盘（此前这两个字段无处可放，直接被丢掉）
  const r2 = await p.tools.find((t) => t.name === 'intake_collect').run({ patientId: 'P001', consultText: '复诊' },
    { llm: async () => ({ data: { complete: true, ...F, shexiang: '舌红苔黄', maixiang: '脉弦细' } }) });
  assert.equal(r2.ok, true);
  const f2 = fs.readdirSync(file(path.join('intake', 'P001'))).filter((x) => x.endsWith('.json')).sort();
  const latest = JSON.parse(fs.readFileSync(file(path.join('intake', 'P001', f2[f2.length - 1])), 'utf8'));
  assert.equal(latest.shexiang, '舌红苔黄');
  assert.equal(latest.maixiang, '脉弦细');
});

await testAsync('completeness 红线只看两项必填，不因可选字段缺失而拒绝', async () => {
  const c = pack.constraints.find((x) => x.kind === 'completeness');
  assert.deepEqual(c.fields, ['zhushu', 'xianbingshi']);
  for (const opt of ['jiwangshi', 'jiazushi', 'guominshi', 'liuxingbingshi', 'tigejiancha', 'shexiang', 'maixiang', 'suifang']) {
    assert.ok(!c.fields.includes(opt), `${opt} 不得进必填`);
  }
  const partial = Object.fromEntries(c.fields.map((k) => [k, '']));
  partial.shexiang = '舌红苔黄';
  assert.equal(missingFields(partial).length, 2, '只有可选字段填了，两项必填仍应全部算缺');
});

// 收尾：清掉临时 home（测试全程不写真实 MINGDAO_HOME）
fs.rmSync(TMP_HOME, { recursive: true, force: true });
fs.rmSync(HOME2, { recursive: true, force: true });

console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
