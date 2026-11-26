'use strict';
/**
 * SMOKE TEST (API_TEST) — chay voi server DB_MODE=test-postgres.
 * Phu song cac domain da refactor direct-params: account, slot, po(+t8),
 * lot, activity, receipt, material. Sau test se don dep du lieu [API_TEST].
 * Cach chay: node tmp-smoke-pg.js http://localhost:3117
 */
const BASE = process.argv[2] || 'http://localhost:3117';
let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 300) : ''}`);
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

(async () => {
  // ---------- LOGIN (ca 2 role) ----------
  const mgr = await api('POST', '/api/warehouse/auth/login', { body: { empNo: 'TEST-MGR', password: '123456' } });
  check('login MGR 200 + token', mgr.status === 200 && !!(mgr.json && mgr.json.token), mgr);
  const kpr = await api('POST', '/api/warehouse/auth/login', { body: { empNo: 'TEST-KPR', password: '123456' } });
  check('login KPR 200 + token', kpr.status === 200 && !!(kpr && kpr.json && kpr.json.token), kpr);
  const T = (kpr.json && kpr.json.token) || '';
  const M = (mgr.json && mgr.json.token) || '';

  const me = await api('GET', '/api/warehouse/auth/me', { token: T });
  check('GET /auth/me 200 (account domain)', me.status === 200 && !!(me.json && me.json.account), me);

  const boot = await api('GET', '/api/warehouse/', { token: T });
  check('GET / bootstrap 200', boot.status === 200 && !!boot.json, boot);

  // ---------- ACCOUNT ----------
  const acc = await api('GET', '/api/warehouse/accounts?page=1&pageSize=2', { token: M });
  check(
    'GET /accounts paged 200 (offset swap)',
    acc.status === 200 && acc.json && Array.isArray(acc.json.items) && acc.json.items.length === 2,
    acc
  );
  // 2026-10-28: kỳ vọng cũ 403 đã stale — quyền đọc /accounts cho KPR đã
  // được mở chủ động 2026-10-22 (thủ kho cần tên người trên bản đồ kho).
  const accKpr = await api('GET', '/api/warehouse/accounts?page=1&pageSize=2', { token: T });
  check('GET /accounts KPR -> 200 (đọc đã mở 2026-10-22)', accKpr.status === 200, accKpr);

  // ---------- SLOT ----------
  const slots = await api('GET', '/api/warehouse/slots', { token: T });
  check('GET /slots 200 (slot list)', slots.status === 200 && Array.isArray(slots.json), { status: slots.status });
  const slotSearch = await api('GET', '/api/warehouse/slots/search?keyword=A&limit=5', { token: T });
  check(
    'GET /slots/search 200 (LIKE filter)',
    slotSearch.status === 200 && slotSearch.json && Array.isArray(slotSearch.json.codes),
    { status: slotSearch.status, body: slotSearch.json }
  );

  // ---------- PO / T8 ----------
  const pos = await api('GET', '/api/warehouse/pos?page=1&pageSize=5', { token: T });
  check(
    'GET /pos paged 200 (fillTempTables pipeline)',
    pos.status === 200 && pos.json && Array.isArray(pos.json.items),
    { status: pos.status, body: pos.json }
  );
  const firstPo = pos.json && pos.json.items && pos.json.items[0];
  const posKw = await api('GET', '/api/warehouse/pos?keyword=PO&pageSize=5', { token: T });
  check(
    'GET /pos?keyword 200 (searchPurchasesFinal)',
    posKw.status === 200 && posKw.json && Array.isArray(posKw.json.items),
    { status: posKw.status, body: posKw.json }
  );
  const incoming = await api('GET', '/api/warehouse/incoming-pos', { token: T });
  check('GET /incoming-pos 200', incoming.status === 200, { status: incoming.status });

  // ---------- LOT ----------
  const lots = await api('GET', '/api/warehouse/lots?page=1&pageSize=3', { token: T });
  check(
    'GET /lots paged 200 (lot listPaged)',
    lots.status === 200 && lots.json && Array.isArray(lots.json.items),
    { status: lots.status, body: lots.json }
  );

  // ---------- ACTIVITY ----------
  const act = await api('GET', '/api/warehouse/activity?page=1&pageSize=3', { token: M });
  check(
    'GET /activity paged 200 (activity searchPage)',
    act.status === 200 && act.json && Array.isArray(act.json.items),
    { status: act.status, body: act.json }
  );

  // ---------- MATERIAL ----------
  const mat = await api('GET', '/api/warehouse/materials?page=1&pageSize=3', { token: M });
  check(
    'GET /materials paged 200 (material listPaged)',
    mat.status === 200 && mat.json && Array.isArray(mat.json.items),
    { status: mat.status, body: mat.json }
  );
  const matKw = await api('GET', '/api/warehouse/materials?search=thep&page=1&pageSize=3', { token: M });
  check('GET /materials?search 200 (optional filter)', matKw.status === 200, { status: matKw.status });

  // ---------- WRITE: assign (po -> lot -> movement -> receipt) ----------
  let allocId = null;
  let poId = null;
  let slotCode = null;
  let matGoodsNo = null;
  // Gan 1 ke cho TEST-KPR (mock slots deu thuoc EMP001/EMP002)
  const allSlots = (slots.json && Array.isArray(slots.json) ? slots.json : []);
  slotCode = (allSlots[0] && allSlots[0].code) || null;
  if (slotCode) {
    const sk = await api('POST', '/api/warehouse/slots/assign-keeper', {
      token: M,
      body: { codes: [slotCode, (allSlots[1] && allSlots[1].code) || slotCode], keeperEmpNo: 'TEST-KPR' },
    });
    check('POST /slots/assign-keeper 2xx (updateSlot keeper)', sk.status === 200 || sk.status === 201, { status: sk.status, body: sk.json });
  }
  if (firstPo) {
    poId = firstPo.poLine || firstPo.id;
    // 2026-10-28: assignedQty = tổng PO (kể cả closed) chỉ để hiển thị —
    // dòng qty đã là lượng còn có thể gán của dòng (gap trừ noticed/gap_assigned,
    // notice = full đợt tạm nhập), dùng trực tiếp.
    const avail = firstPo.qty;
    if (slotCode && avail > 0) {
      const asg = await api('POST', '/api/warehouse/assign', {
        token: T,
        body: { poId, slotCode, qty: Math.min(avail, 5), note: '[API_TEST] direct-params smoke' },
      });
      check(
        'POST /assign 2xx (tx write path)',
        (asg.status === 200 || asg.status === 201) && asg.json && asg.json.id,
        { status: asg.status, body: asg.json }
      );
      if (asg.json && asg.json.id) {
        allocId = asg.json.id;
        // Assign có thể merge vào allocation đang active của cùng (PO, slot) —
        // id trả về là allocation cũ, có thể nằm ngoài trang 1. Quét hết
        // các trang theo total để xác nhận write->read (state-robust).
        let found = false;
        let page = 1;
        for (; ;) {
          const lot = await api('GET', `/api/warehouse/lots?page=${page}&pageSize=50`, { token: T });
          if (lot.status !== 200 || !lot.json || !Array.isArray(lot.json.items)) break;
          if (lot.json.items.some((l) => l.id === allocId)) { found = true; break; }
          const pages = Math.max(1, Math.ceil((lot.json.total || 0) / 50));
          if (page >= pages) break;
          page += 1;
        }
        check('assigned lot visible in /lots (write->read, scan all pages)', !!found);
      }
      const mv = await api('POST', `/api/warehouse/lots/${allocId}/move`, {
        token: T,
        body: { targetSlotCode: (slots.json && slots.json[1] && slots.json[1].code) || slotCode, qty: 1 },
      });
      check('POST /lots/:id/move 2xx (moveSlot + close)', mv.status === 200 || mv.status === 201, { status: mv.status, body: mv.json });
      const iqc = await api('POST', `/api/warehouse/lots/${allocId}/iqc`, {
        token: T,
        body: { decision: 'PASS' },
      });
      const dupIqc = iqc.status === 400 && iqc.json && iqc.json.error && iqc.json.error.code === 'BUSINESS_ERROR' && /dup/i.test(String(iqc.json.error.message));
      check(
        'POST /lots/:id/iqc 2xx or dup_iqc (idempotent re-run)',
        iqc.status === 200 || iqc.status === 201 || dupIqc,
        { status: iqc.status, body: iqc.json }
      );
    } else {
      check('POST /assign skipped — no slot/avail', false, { slotCode, avail });
    }
  } else {
    check('POST /assign skipped — /pos empty', false);
  }

  // ---------- WRITE: material assign-keeper ----------
  if (mat.json && mat.json.items && mat.json.items.length > 0) {
    matGoodsNo = mat.json.items[0].goodsNo;
    const mk = await api('POST', '/api/warehouse/materials/assign-keeper', {
      token: M,
      body: { goodsNo: matGoodsNo, keeperEmpNo: 'TEST-KPR', note: '[API_TEST] smoke' },
    });
    check(
      'POST /materials/assign-keeper 2xx (closeActive + insert tx)',
      (mk.status === 200 || mk.status === 201) && mk.json && mk.json.material,
      { status: mk.status, body: mk.json }
    );
    const hist = await api('GET', `/api/warehouse/materials/${encodeURIComponent(matGoodsNo)}/history`, { token: M });
    check('GET /materials/:goodsNo/history 200', hist.status === 200, { status: hist.status, body: hist.json });
  }

  console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('SMOKE CRASH', e);
  process.exit(1);
});
