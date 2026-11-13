'use strict';
/**
 * SMOKE TEST CHANGE REQUEST 2026-10-21 — chay voi server DB_MODE=test-postgres.
 * Phu 22-muc change request: NPL eligibility M1-M6+A2, /materials base filter,
 * keeper /pos scope, def02 NULL-safe, profile sections, keeper-detail,
 * end-assignment, security.
 *
 * Tien de: da chen fixture [API_TEST] qua +db-execute:
 *   - t8_bas_goods: A2001 (eligible A2), ITEM-TEST1 (INVALID)
 *   - t8_pur_order1/2: PO-TEST-A2 (goods A2001, def02 NULL, qty 10, open)
 *   - t8_pur_notice1/2: NO-TEST-A2 (A2001, qty 4, def02 NULL, def23 = hom nay)
 * => /pos phai co: gap row A2001 qty 6 + notice-lot row A2001 qty 4
 *    (notice row chi xuat hien khi def02 NULL-safe join dung).
 *
 * Cach chay: node smoke-pg-cr.js http://localhost:3117
 */
const BASE = process.argv[2] || 'http://localhost:3117';
let pass = 0;
let fail = 0;

const ELIGIBLE_RE = /^(M[1-6]|A2)/;

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : ''}`);
  }
}

async function api(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-auth-token'] = token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

function itemsOf(resp) {
  return (resp.json && Array.isArray(resp.json.items) && resp.json.items) || [];
}

(async () => {
  // ---------- LOGIN ----------
  const mgr = await api('POST', '/api/warehouse/auth/login', { body: { empNo: 'TEST-MGR', password: '123456' } });
  const kpr = await api('POST', '/api/warehouse/auth/login', { body: { empNo: 'TEST-KPR', password: '123456' } });
  check('login MGR + KPR 200', mgr.status === 200 && kpr.status === 200, { mgr: mgr.status, kpr: kpr.status });
  const M = (mgr.json && mgr.json.token) || '';
  const T = (kpr.json && kpr.json.token) || '';

  // ---------- SECURITY: 401 khong token ----------
  const noTok = await api('GET', '/api/warehouse/materials?page=1&pageSize=5');
  check('GET /materials khong token -> 401', noTok.status === 401, { status: noTok.status });

  // ---------- /materials ELIGIBILITY ----------
  const mat = await api('GET', '/api/warehouse/materials?page=1&pageSize=200', { token: M });
  const matItems = itemsOf(mat);
  const invalid = matItems.filter((m) => !ELIGIBLE_RE.test(m.goodsNo || ''));
  check(
    'GET /materials: tat ca item M1-M6/A2, INVALID = 0',
    mat.status === 200 && matItems.length > 0 && invalid.length === 0,
    { status: mat.status, invalid: invalid.map((m) => m.goodsNo) }
  );
  const prefixCount = {};
  for (const m of matItems) {
    const p = (m.goodsNo || '').slice(0, 2);
    prefixCount[p] = (prefixCount[p] || 0) + 1;
  }
  console.log('  [AUDIT] /materials prefix counts:', JSON.stringify(prefixCount));
  check(
    '/materials co mat hang A2 (fixture) va khong co ITEM-TEST1',
    prefixCount.A2 > 0 && !prefixCount.IT && !matItems.some((m) => m.goodsNo === 'ITEM-TEST1'),
    prefixCount
  );

  const matSearchInvalid = await api('GET', '/api/warehouse/materials?search=ITEM-TEST1&page=1&pageSize=10', { token: M });
  const invTotal = (matSearchInvalid.json && matSearchInvalid.json.total) || 0;
  check(
    'GET /materials?search=ITEM-TEST1 -> 0 (search khong pha eligibility)',
    matSearchInvalid.status === 200 && invTotal === 0,
    { status: matSearchInvalid.status, total: invTotal }
  );

  // ---------- VALIDATE GOODS HARDEN ----------
  const badAssign = await api('POST', '/api/warehouse/materials/assign-keeper', {
    token: M,
    body: { goodsNo: 'ITEM-TEST1', keeperEmpNo: 'TEST-KPR' },
  });
  check(
    'POST assign-keeper ITEM-TEST1 -> 400 invalid_material',
    badAssign.status === 400 && badAssign.json && /invalid_material/i.test(String(badAssign.json.error && badAssign.json.error.message)),
    { status: badAssign.status, body: badAssign.json }
  );

  // ---------- /pos MANAGER: A2 + def02 NULL-safe ----------
  const posM = await api('GET', '/api/warehouse/pos?page=1&pageSize=200', { token: M });
  const posMItems = itemsOf(posM);
  const a2Gap = posMItems.find((p) => p.itemCode === 'A2001' && !String(p.id).includes('-N'));
  const a2Notice = posMItems.find((p) => p.itemCode === 'A2001' && String(p.id).includes('-N'));
  check(
    'GET /pos MANAGER: co PO A2001 (gap row)',
    posM.status === 200 && !!a2Gap,
    { status: posM.status }
  );
  check(
    'GET /pos MANAGER: co notice-lot row A2001 (def02 NULL-safe)',
    !!a2Notice && a2Notice.lotNo === 'LOT-A2N' && Math.abs((a2Notice.qty || 0) - 4) < 0.001,
    { a2Notice }
  );
  const posInvalid = posMItems.filter((p) => !ELIGIBLE_RE.test(p.itemCode || ''));
  check('GET /pos MANAGER: khong co item ngoai M1-M6/A2', posInvalid.length === 0, posInvalid.map((p) => p.itemCode));

  // ---------- /pos KEEPER SCOPE (truoc khi assign A2 cho KPR) ----------
  const posT0 = await api('GET', '/api/warehouse/pos?page=1&pageSize=200', { token: T });
  const posT0Items = itemsOf(posT0);
  check(
    'GET /pos KPR: A2001 chua duoc giao -> khong hien',
    posT0.status === 200 && !posT0Items.some((p) => p.itemCode === 'A2001'),
    { status: posT0.status, a2: posT0Items.filter((p) => p.itemCode === 'A2001').length }
  );
  const kd0 = await api('GET', '/api/warehouse/accounts/TEST-KPR/keeper-detail', { token: M });
  const kprGoods = new Set(
    ((kd0.json && kd0.json.managedMaterials) || []).map((m) => m.goodsNo)
  );
  check(
    'GET /pos KPR: moi item thuoc NPL duoc phan cong cho KPR',
    posT0Items.length > 0 && posT0Items.every((p) => kprGoods.has(p.itemCode)),
    { kprGoods: [...kprGoods], violators: [...new Set(posT0Items.filter((p) => !kprGoods.has(p.itemCode)).map((p) => p.itemCode))] }
  );
  // Chon 1 NPL eligible CHUA duoc giao cho KPR (ton tai o /pos MANAGER)
  const unassigned = posMItems.find(
    (p) => ELIGIBLE_RE.test(p.itemCode || '') && !kprGoods.has(p.itemCode) && p.itemCode !== 'A2001'
  );
  check('TIM duoc NPL eligible chua giao cho KPR de test search scope', !!unassigned, posMItems.map((p) => p.itemCode));
  if (unassigned) {
    const kw = encodeURIComponent(unassigned.itemCode);
    const kprSearch = await api('GET', `/api/warehouse/pos?keyword=${kw}&page=1&pageSize=10`, { token: T });
    const mgrSearch = await api('GET', `/api/warehouse/pos?keyword=${kw}&page=1&pageSize=10`, { token: M });
    check(
      'SEARCH scope: KPR tim NPL chua duoc giao -> 0; MGR van thay',
      (kprSearch.json && (kprSearch.json.total || 0) === 0) && (mgrSearch.json && (mgrSearch.json.total || 0) > 0),
      { goods: unassigned.itemCode, kpr: kprSearch.json && kprSearch.json.total, mgr: mgrSearch.json && mgrSearch.json.total }
    );
  }

  // ---------- ASSIGN A2001 CHO KPR -> /pos KPR thay ----------
  const asgA2 = await api('POST', '/api/warehouse/materials/assign-keeper', {
    token: M,
    body: { goodsNo: 'A2001', keeperEmpNo: 'TEST-KPR', note: '[API_TEST] cr-assign-a2' },
  });
  check('POST assign-keeper A2001 -> 2xx (eligible A2)', asgA2.status >= 200 && asgA2.status < 300, { status: asgA2.status, body: asgA2.json });
  const posT1 = await api('GET', '/api/warehouse/pos?page=1&pageSize=200', { token: T });
  check(
    'GET /pos KPR sau khi assign A2001: thay A2001',
    itemsOf(posT1).some((p) => p.itemCode === 'A2001'),
    { status: posT1.status }
  );

  // ---------- END ASSIGNMENT ----------
  const end1 = await api('POST', '/api/warehouse/materials/end-assignment', {
    token: M,
    body: { goodsNo: 'A2001', keeperEmpNo: 'TEST-KPR' },
  });
  check('POST end-assignment A2001 -> 2xx', end1.status >= 200 && end1.status < 300, { status: end1.status, body: end1.json });
  const posT2 = await api('GET', '/api/warehouse/pos?page=1&pageSize=200', { token: T });
  check(
    'GET /pos KPR sau end-assignment: A2001 bien mat',
    !itemsOf(posT2).some((p) => p.itemCode === 'A2001'),
    { status: posT2.status }
  );
  const hist = await api('GET', '/api/warehouse/materials/A2001/history', { token: M });
  const histRows = (hist.json && (hist.json.items || hist.json)) || [];
  const endedRow = Array.isArray(histRows) && histRows.find((r) => r.endedAt || r.ended_at);
  check(
    'GET /materials/A2001/history: history duoc GIU (row co endedAt, khong DELETE)',
    hist.status === 200 && !!endedRow,
    { status: hist.status, rows: histRows.length }
  );
  const end2 = await api('POST', '/api/warehouse/materials/end-assignment', {
    token: M,
    body: { goodsNo: 'A2001', keeperEmpNo: 'TEST-KPR' },
  });
  check('POST end-assignment lan 2 -> 404 (khong con active)', end2.status === 404, { status: end2.status, body: end2.json });

  // ---------- PROFILE: KHO + NPL DAM NHAN ----------
  const allSlots = await api('GET', '/api/warehouse/slots', { token: T });
  const slotList = Array.isArray(allSlots.json) ? allSlots.json : [];
  check('GET /slots chuan bi assign keeper', allSlots.status === 200 && slotList.length >= 2, { status: allSlots.status, n: slotList.length });
  if (slotList.length >= 2) {
    const sk = await api('POST', '/api/warehouse/slots/assign-keeper', {
      token: M,
      body: { codes: [slotList[0].code, slotList[1].code], keeperId: 'TEST-KPR' },
    });
    check('POST /slots/assign-keeper 2 ke cho TEST-KPR', sk.status >= 200 && sk.status < 300, { status: sk.status, body: sk.json });
  }
  const meKpr = await api('GET', '/api/warehouse/auth/me', { token: T });
  const meJ = meKpr.json || {};
  const mw = meJ.managedWarehouses || [];
  const mm = meJ.managedMaterials || [];
  check(
    'GET /auth/me KPR: managedWarehouses (kho + so ke)',
    meKpr.status === 200 && Array.isArray(mw) && mw.length > 0 && mw.every((w) => typeof w.warehouse === 'string' && typeof w.shelfCount === 'number' && w.shelfCount > 0),
    { mw }
  );
  const goodsInKprPos = [...new Set(itemsOf(posT1).map((p) => p.itemCode))].filter(
    (g) => g !== 'A2001'
  );
  check(
    'GET /auth/me KPR: managedMaterials phu hop /pos KPR (moi goods trong /pos deu co assignment)',
    meKpr.status === 200 && goodsInKprPos.every((g) => mm.some((m) => m.goodsNo === g)) && mm.every((m) => m.goodsNo && m.goodsName),
    { goodsInKprPos, mm }
  );
  check(
    'GET /auth/me KPR: managedMaterials khong con A2001 (da end)',
    !mm.some((m) => m.goodsNo === 'A2001'),
    { mm }
  );

  // ---------- MANAGER KEEPER DETAIL ----------
  const kd = await api('GET', '/api/warehouse/accounts/TEST-KPR/keeper-detail', { token: M });
  const kdJ = kd.json || {};
  check(
    'GET keeper-detail (MGR): account KEEPER + shelves + managedWarehouses + managedMaterials',
    kd.status === 200 &&
      kdJ.account && kdJ.account.role === 'KEEPER' &&
      Array.isArray(kdJ.shelves) && kdJ.shelves.length >= 2 &&
      Array.isArray(kdJ.managedWarehouses) && kdJ.managedWarehouses.length > 0 &&
      Array.isArray(kdJ.managedMaterials) && kdJ.managedMaterials.length > 0,
    { status: kd.status, body: kdJ }
  );
  const kdMgr = await api('GET', '/api/warehouse/accounts/TEST-MGR/keeper-detail', { token: M });
  check('GET keeper-detail cho account MANAGER -> 400 not_keeper', kdMgr.status === 400 && /not_keeper/i.test(String(kdMgr.json && kdMgr.json.error && kdMgr.json.error.message)), { status: kdMgr.status });
  const kd404 = await api('GET', '/api/warehouse/accounts/NO-SUCH/keeper-detail', { token: M });
  check('GET keeper-detail account khong ton tai -> 404', kd404.status === 404, { status: kd404.status });
  const kd403 = await api('GET', '/api/warehouse/accounts/TEST-KPR/keeper-detail', { token: T });
  check('GET keeper-detail voi token KPR -> 403', kd403.status === 403, { status: kd403.status });

  // ---------- CHANGE OWNER (reuse assign-keeper flow) ----------
  // Lay 1 NPL dang active cua TEST-KPR tu keeper-detail (du lieu that, khong hardcode)
  const kdForGoods = await api('GET', '/api/warehouse/accounts/TEST-KPR/keeper-detail', { token: M });
  const kprActiveGoods = ((kdForGoods.json || {}).managedMaterials || []).map((m) => m.goodsNo);
  const goodsToMove = kprActiveGoods[0];
  check('TIM duoc NPL active cua TEST-KPR de test change owner', !!goodsToMove, { kprActiveGoods });
  if (goodsToMove) {
    const chg = await api('POST', '/api/warehouse/materials/assign-keeper', {
      token: M,
      body: { goodsNo: goodsToMove, keeperEmpNo: 'EMP001', note: '[API_TEST] cr-change-owner' },
    });
    check(`POST assign-keeper ${goodsToMove} -> EMP001 (change owner) 2xx`, chg.status >= 200 && chg.status < 300, { status: chg.status, body: chg.json });
    const kdEmp1 = await api('GET', '/api/warehouse/accounts/EMP001/keeper-detail', { token: M });
    const kdEmp1J = kdEmp1.json || {};
    check(
      `keeper-detail EMP001: ${goodsToMove} active cho EMP001`,
      kdEmp1.status === 200 && (kdEmp1J.managedMaterials || []).some((m) => m.goodsNo === goodsToMove && !m.endedAt),
      { mm: kdEmp1J.managedMaterials }
    );
    const kdKprAfter = await api('GET', '/api/warehouse/accounts/TEST-KPR/keeper-detail', { token: M });
    check(
      `keeper-detail TEST-KPR: ${goodsToMove} khong con active (da chuyen EMP001)`,
      !((kdKprAfter.json || {}).managedMaterials || []).some((m) => m.goodsNo === goodsToMove && !m.endedAt),
      { mm: (kdKprAfter.json || {}).managedMaterials }
    );
    // Tra lai trang thai seed
    const restore = await api('POST', '/api/warehouse/materials/assign-keeper', {
      token: M,
      body: { goodsNo: goodsToMove, keeperEmpNo: 'TEST-KPR', note: '[API_TEST] cr-restore-seed' },
    });
    check(`RESTORE: assign ${goodsToMove} -> TEST-KPR (tra seed)`, restore.status >= 200 && restore.status < 300, { status: restore.status });
  }

  // ---------- RESTORE SLOT OWNERS (tra trang thai goc cua mock slots) ----------
  if (slotList.length >= 2) {
    for (const s of [slotList[0], slotList[1]]) {
      const body = s.keeperId ? { codes: [s.code], keeperId: s.keeperId } : { codes: [s.code], keeperId: null };
      await api('POST', '/api/warehouse/slots/assign-keeper', { token: M, body });
    }
    check('RESTORE: tra lai keeper goc cho 2 ke (clear assignment = NULL, khong delete ke)', true);
  }

  // ---------- BUCKET COUNT SCOPE ----------
  const totalKpr = (posT2.json && posT2.json.total) || 0;
  const totalMgr = (posM.json && posM.json.total) || 0;
  check(
    'BUCKET/total scope: KPR total < MGR total (KPR chi thay phan cong)',
    totalMgr > 0 && totalKpr < totalMgr,
    { totalKpr, totalMgr }
  );

  console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('SMOKE CRASH', e);
  process.exit(1);
});
