/**
 * ACCEPTANCE TEST — FINAL WHS DATABASE CORRECTION (2026-10-17).
 * Chay voi server o che do test-postgres + DB_TABLE_PREFIX=whs3_ (PORT=3111)
 * hoac memory (PORT=3112). Cases A-F theo yeu cau user.
 *
 * Cach chay: node test/acceptance-final-whs.test.js [baseUrl]
 */
'use strict';

const BASE = process.argv[2] || 'http://localhost:3111';
let pass = 0;
let fail = 0;

function check(name, cond, extra) {
    if (cond) {
        pass += 1;
        console.log(`  PASS ${name}`);
    } else {
        fail += 1;
        console.log(`  FAIL ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`);
    }
}

async function api(method, path, body) {
    const res = await fetch(BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
        json = await res.json();
    } catch {
        /* no body */
    }
    return { status: res.status, json };
}

async function main() {
    // ---------- Bootstrap ----------
    const accounts = await api('GET', '/api/warehouse/accounts');
    check('bootstrap accounts 2xx', accounts.status >= 200 && accounts.status < 300, accounts);
    const mgr = (accounts.json || []).find((a) => a.username === 'TEST-MGR') || (accounts.json || [])[0];
    const actorId = mgr.id;
    const slots = await api('GET', '/api/warehouse/slots');
    const slotList = slots.json || [];
    const free = slotList.filter((s) => s.active && !s.locked);
    check('slots available >= 3', free.length >= 3, { free: free.length });
    const [s1, s2, s3] = free.map((s) => s.code);

    // ---------- Case A: PO co, notice chua co -> assign duoc, KHONG tao receipt gia ----------
    // PO-25013 dong 13: khong co notice nao khop (gap thuan).
    const a1 = await api('POST', '/api/warehouse/assign', {
        actorId,
        poId: 13,
        slotCode: s1,
        qty: 100,
    });
    check('A: assign khi chua co notice thanh cong', a1.status >= 200 && a1.status < 300, a1);
    const allocA = a1.json || {};
    check('A: status WAITING_IQC', allocA.status === 'WAITING_IQC', allocA);

    // ---------- Case B: 1 PO detail co 2 notice -> nhan ca 2 receiving ----------
    const pos14 = await api('GET', '/api/warehouse/pos?keyword=PO-25014&pageSize=100');
    const rows14 = (pos14.json || { items: [] }).items || [];
    const noticeRows = rows14.filter((r) => String(r.id).includes('-N'));
    check('B: /pos hien 2 dong notice cho PO-25014', noticeRows.length === 2, rows14.map((r) => r.id));
    const lotNos = noticeRows.map((r) => r.lotNo).sort();
    check(
        'B: 2 lot rieng biet (khong overwrite)',
        lotNos.length === 2 && lotNos[0] !== lotNos[1],
        lotNos
    );

    // ---------- Case C: 1 PO detail chia 3 ke -> 3 allocation khac nhau, khong merge ----------
    const c1 = await api('POST', '/api/warehouse/assign', { actorId, poId: 17, slotCode: s1, qty: 50 });
    const c2 = await api('POST', '/api/warehouse/assign', { actorId, poId: 17, slotCode: s2, qty: 50 });
    const c3 = await api('POST', '/api/warehouse/assign', { actorId, poId: 17, slotCode: s3, qty: 50 });
    const ids = new Set([c1.json.id, c2.json.id, c3.json.id]);
    check('C: 3 allocation id khac nhau', ids.size === 3, [c1.json.id, c2.json.id, c3.json.id]);
    const lot17 = await api('GET', '/api/warehouse/lots?pageSize=200');
    const rows17 = (lot17.json || { items: [] }).items || [];
    const allocs17 = rows17.filter(
        (l) => l.poNumber === 'PO-25015' && String(l.poLine) === '17'
    );
    check('C: /lots co 3 dong cho PO 17 (khong auto merge)', allocs17.length === 3, allocs17.length);

    // ---------- Case D: nhieu allocation x nhieu notice -> KHONG doan mapping ----------
    // PO 14 (2 notice) + assign them 1 ke nua -> 2 alloc x 2 notice.
    const d1 = await api('POST', '/api/warehouse/assign', { actorId, poId: 14, slotCode: s2, qty: 1000 });
    check('D: assign tren PO 2 notice van chay', d1.status >= 200 && d1.status < 300, d1);
    // Tong so lot sau Case D (so voi truoc): A(+1) + C(+3) + B-test(+1) + D(+1)
    const afterLots = await api('GET', '/api/warehouse/lots?pageSize=200');
    const rowsAfter = (afterLots.json || { items: [] }).items || [];
    const created = rowsAfter.filter(
        (l) => [allocA.id, c1.json.id, c2.json.id, c3.json.id, d1.json.id].includes(l.id)
    );
    check('D: cac allocation moi deu xuat hien trong /lots', created.length === 5, created.length);

    // ---------- Mapping 1-1: PO 16 (1 notice 14) + 1 allocation -> receipt tu dong ----------
    const e1 = await api('POST', '/api/warehouse/assign', { actorId, poId: 16, slotCode: s3, qty: 150 });
    check('E: assign PO 16 thanh cong', e1.status >= 200 && e1.status < 300, e1);
    const alloc16 = e1.json || {};
    check('E: lot mirror duoc set khi 1 alloc x 1 notice', Boolean(alloc16.lotCode), alloc16);

    // ---------- IQC inject len allocation co receipt ----------
    const iq = await api('POST', `/api/warehouse/lots/${alloc16.id}/iqc`, {
        actorId,
        decision: 'PASS',
    });
    check('IQC: inject PASS chay', iq.status >= 200 && iq.status < 300, iq);
    check('IQC: status -> IN_STOCK', (iq.json || {}).status === 'IN_STOCK', iq.json);

    // ---------- IQC inject len allocation khong co receipt (Case A alloc) ----------
    const iqA = await api('POST', `/api/warehouse/lots/${allocA.id}/iqc`, {
        actorId,
        decision: 'PASS',
    });
    check('IQC: ap ket qua du khong co receipt (khong not_found)', iqA.status >= 200 && iqA.status < 300, iqA);
    check('IQC: alloc A -> IN_STOCK', (iqA.json || {}).status === 'IN_STOCK', iqA.json);

    // ---------- Activity co poId ----------
    const acts = await api('GET', '/api/warehouse/activity?pageSize=50');
    const actRows = (acts.json || { items: [] }).items || [];
    const assignActs = actRows.filter((x) => x.actionKey === 'actAssign');
    check('activity: co ban ghi actAssign moi', assignActs.length > 0, actRows.length);

    // ---------- Ghi lai id de script DB verify dung lai ----------
    console.log('\nIDS=' + JSON.stringify({ allocA: allocA.id, alloc16: alloc16.id }));

    console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
});
