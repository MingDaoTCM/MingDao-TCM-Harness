// 问诊台数据层测试（患者名册 / 单患者历史 / 随访提醒）。
// 运行：node tools/tcm-ui/test/tcm-data.test.mjs
//
// 这一层必须测的是**派生语义**，不是 HTTP：
//   · 排序（超期 > 临期 > 正常 > 未就诊）、汇总；
//   · 时间线方向（最早→最新）、中文标签来自 Pack；
//   · 逐项变化（只列真的变了的字段，带 from/to）；
//   · 提醒集只含该催的两类，且计数与名册同源；
//   · 失败必须**大声**（注册表损坏不许显示成「0 位患者」）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { roster, patientDetail, reminders } from '../tcm-data.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${e?.message || e}`); }
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-data-test-'));
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const writeSnap = (pid, ts, fields) => {
  const dir = path.join(HOME, 'intake', pid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `case-${ts}.json`), JSON.stringify({ patientId: pid, collectedAt: iso(0), ...fields }));
};
// 刻意覆盖四种随访状态：超期(P002,20天) / 临期(P003,12天) / 正常(P001,3天) / 未就诊(P004)
fs.writeFileSync(path.join(HOME, 'patients.json'), JSON.stringify({
  nextId: 5,
  patients: {
    P001: { id: 'P001', name: '张三', birth: '1985', sex: '女', lastVisitAt: iso(3), visits: 2 },
    P002: { id: 'P002', name: '李四', birth: '1970', sex: '男', lastVisitAt: iso(20), visits: 1 },
    P003: { id: 'P003', name: '王五', birth: '1990', sex: '男', lastVisitAt: iso(12), visits: 1 },
    P004: { id: 'P004', name: '赵六', birth: '2000', sex: '女', lastVisitAt: '', visits: 0 },
  },
}));
writeSnap('P001', 1000, { zhushu: '失眠', xianbingshi: '三月前入睡困难' });
writeSnap('P001', 2000, { zhushu: '失眠好转', xianbingshi: '入睡时间提前', shexiang: '舌红苔黄' });
writeSnap('P002', 1500, { zhushu: '胃脘胀满', xianbingshi: '餐后加重' });
writeSnap('P003', 1600, { zhushu: '咳嗽', xianbingshi: '受凉后咳嗽两周' });

console.log('\n[1] 患者名册');
test('汇总与就诊次数（就诊次数取自快照文件数，不是注册表字段）', () => {
  const r = roster(HOME);
  assert.equal(r.ok, true);
  assert.equal(r.patients.length, 4);
  assert.equal(r.totals.patients, 4);
  assert.equal(r.totals.visits, 4, '2 + 1 + 1 + 0');
  assert.equal(r.patients.find((p) => p.id === 'P001').visits, 2);
  assert.equal(r.patients.find((p) => p.id === 'P004').visits, 0);
});
test('★ 排序按严重度：超期 > 临期 > 正常 > 未就诊', () => {
  const r = roster(HOME);
  assert.deepEqual(r.patients.map((p) => p.id), ['P002', 'P003', 'P001', 'P004'],
    '实际顺序：' + r.patients.map((p) => `${p.id}(${p.status})`).join(' '));
});
test('★ 每行都带随访状态（status 来自 Pack 的口径，不是前端自己算）', () => {
  const r = roster(HOME);
  const by = Object.fromEntries(r.patients.map((p) => [p.id, p]));
  assert.equal(by.P002.status, 'overdue');
  assert.equal(by.P003.status, 'due-soon');
  assert.equal(by.P001.status, 'ok');
  assert.equal(by.P004.status, 'none', '从未就诊');
  assert.equal(by.P002.statusCn, '超期');
  assert.equal(by.P003.statusCn, '临期');
  assert.equal(r.totals.overdue, 1);
  assert.equal(r.totals.dueSoon, 1);
  assert.equal(r.overdueDays, 14, '阈值来自 Pack 的 OVERDUE_DAYS');
  assert.equal(r.dueSoonDays, 3, '提前量来自 Pack 的 DUE_SOON_DAYS');
});

console.log('\n[2] 单患者详情');
test('时间线方向为最早→最新，且带中文标签（标签来自 Pack 的 FIELD_CN）', () => {
  const d = patientDetail(HOME, 'P001');
  assert.equal(d.ok, true);
  assert.equal(d.visits.length, 2);
  assert.equal(d.visits[0].label, '初诊');
  assert.equal(d.visits[1].label, '二诊');
  const zhushu = d.visits[0].items.find((x) => x.key === 'zhushu');
  assert.equal(zhushu.label, '主诉');
  assert.equal(zhushu.value, '失眠');
  assert.equal(d.visits[0].changes.length, 0, '初诊没有「变化」可比');
});
test('★ 逐项变化：只列真的变了的字段，且带 from/to', () => {
  const d = patientDetail(HOME, 'P001');
  const ch = d.visits[1].changes;
  assert.deepEqual(ch.map((c) => c.key).sort(), ['shexiang', 'xianbingshi', 'zhushu'],
    '只有这 3 项变了：' + JSON.stringify(ch.map((c) => c.key)));
  const z = ch.find((c) => c.key === 'zhushu');
  assert.equal(z.from, '失眠');
  assert.equal(z.to, '失眠好转');
  assert.equal(z.label, '主诉');
});
test('items 覆盖全部字段（某个字段为空也要列出，不静默省略）', () => {
  const d = patientDetail(HOME, 'P002');
  assert.equal(d.visits[0].items.length, 10, 'ALL_FIELDS 有几项就该有几项');
  assert.ok(d.visits[0].items.some((x) => x.key === 'maixiang'), '脉象应列出（值可为空串）');
});
test('★ 复诊草稿由服务端生成 —— 前端连"主诉是哪个字段"都不必知道', () => {
  const d = patientDetail(HOME, 'P001');
  assert.match(d.followupDraft, /^复诊：张三，1985年生，女。/);
  assert.match(d.followupDraft, /上次主诉：失眠好转/, '应带上次主诉（取自必填首字段）');
  assert.match(d.followupDraft, /逐项对比本次变化/);
});

console.log('\n[3] 随访提醒（主动提醒的数据源）');
test('只回该催的两类：超期 + 临期（正常/未就诊不进提醒）', () => {
  const r = reminders(HOME);
  assert.equal(r.ok, true);
  assert.deepEqual(r.overdue.map((p) => p.id), ['P002']);
  assert.deepEqual(r.dueSoon.map((p) => p.id), ['P003']);
  assert.equal(r.counts.overdue, 1);
  assert.equal(r.counts.dueSoon, 1);
  assert.equal(r.counts.total, 4);
  assert.ok(r.generatedAt, '带生成时间，便于前端判断新鲜度');
});
test('★ 提醒计数与名册汇总同源（不会出现"看板说 3 位、提醒条说 2 位"）', () => {
  const a = roster(HOME);
  const b = reminders(HOME);
  assert.equal(b.counts.overdue, a.totals.overdue);
  assert.equal(b.counts.dueSoon, a.totals.dueSoon);
  assert.equal(b.counts.total, a.totals.patients);
  assert.equal(b.overdueDays, a.overdueDays);
  assert.equal(b.dueSoonDays, a.dueSoonDays);
});
test('没有需要提醒的患者时：两类都为空、计数为 0', () => {
  const OK = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-data-ok-'));
  fs.writeFileSync(path.join(OK, 'patients.json'), JSON.stringify({
    nextId: 1, patients: { P001: { id: 'P001', name: '张三', lastVisitAt: iso(1), visits: 1 } },
  }));
  const r = reminders(OK);
  assert.equal(r.ok, true);
  assert.equal(r.counts.overdue, 0);
  assert.equal(r.counts.dueSoon, 0);
  fs.rmSync(OK, { recursive: true, force: true });
});

console.log('\n[4] 错误路径（fail-loud —— 与 Pack 同口径）');
test('非法病历号 → 明确拒绝（顺带挡住路径穿越）', () => {
  for (const bad of ['../etc', 'P001/../..', '', 'a b', 'P'.repeat(40)]) {
    assert.equal(patientDetail(HOME, bad).ok, false, `${JSON.stringify(bad)} 必须被拒`);
  }
});
test('不存在的病历号 → 明确报错', () => {
  const d = patientDetail(HOME, 'P999');
  assert.equal(d.ok, false);
  assert.match(d.error, /不存在/);
});
test('★ 注册表损坏 → 名册/详情/提醒都报错，绝不显示成「0 位患者」「没有提醒」', () => {
  const BAD = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-data-bad-'));
  fs.writeFileSync(path.join(BAD, 'patients.json'), '{"nextId":2,"patients":{"P001"');
  const r = roster(BAD);
  assert.equal(r.ok, false, '损坏时 roster 必须失败（显示空名册会让人以为数据没了）');
  assert.match(r.error, /损坏|无法读取|结构不符/);
  assert.equal(patientDetail(BAD, 'P001').ok, false);
  const rem = reminders(BAD);
  assert.equal(rem.ok, false, '提醒也必须是失败态 —— 否则界面会显示"没有需要随访的患者"');
  fs.rmSync(BAD, { recursive: true, force: true });
});
test('全新 home（无注册表）→ 空名册，不报错', () => {
  const FRESH = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-data-fresh-'));
  const r = roster(FRESH);
  assert.equal(r.ok, true);
  assert.equal(r.patients.length, 0);
  assert.equal(reminders(FRESH).counts.overdue, 0);
  fs.rmSync(FRESH, { recursive: true, force: true });
});

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
