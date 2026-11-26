'use strict';

const db = require('../../config/db');
const { TABLES: t, outboundRecipientPredicate } = require('../../config/tables');

function hashParameter() {
    return db.getDialect() === 'pg' ? "decode(?, 'hex')" : 'CONVERT(BINARY(32), ?, 2)';
}

async function save(subscription) {
    const { id, empNo, endpoint, hash, p256dh, auth, platform } = subscription;
    return db.withTransaction(async (tx) => {
        if (db.getDialect() === 'pg') {
            await tx(`
                INSERT INTO ${t.pushSubscription} (id, emp_no, endpoint, endpoint_hash, p256dh, auth, platform)
                VALUES (?, ?, ?, ${hashParameter()}, ?, ?, ?)
                ON CONFLICT (endpoint_hash) DO UPDATE SET emp_no = EXCLUDED.emp_no,
                    endpoint = EXCLUDED.endpoint, p256dh = EXCLUDED.p256dh,
                    auth = EXCLUDED.auth, platform = EXCLUDED.platform
            `, [id, empNo, endpoint, hash, p256dh, auth, platform]);
            return;
        }
        await tx(`
            UPDATE ${t.pushSubscription} WITH (UPDLOCK, SERIALIZABLE)
            SET emp_no = ?, endpoint = ?, p256dh = ?, auth = ?, platform = ?
            WHERE endpoint_hash = ${hashParameter()};
            IF @@ROWCOUNT = 0
                INSERT INTO ${t.pushSubscription} (id, emp_no, endpoint, endpoint_hash, p256dh, auth, platform)
                VALUES (?, ?, ?, ${hashParameter()}, ?, ?, ?);
        `, [empNo, endpoint, p256dh, auth, platform, hash, id, empNo, endpoint, hash, p256dh, auth, platform]);
    });
}

async function remove(empNo, hash) {
    await db.query(`DELETE FROM ${t.pushSubscription} WHERE emp_no = ? AND endpoint_hash = ${hashParameter()}`,
        [empNo, hash]);
}

async function removeExpired(subscription) {
    await db.query(`DELETE FROM ${t.pushSubscription}
        WHERE id = ? AND emp_no = ? AND endpoint = ? AND p256dh = ? AND auth = ?`,
    [subscription.id, subscription.emp_no, subscription.endpoint, subscription.p256dh, subscription.auth]);
}

async function findRecipients(sheetNo) {
    const { rows } = await db.query(`
        SELECT d.id, d.emp_no, d.endpoint, d.p256dh, d.auth, d.platform, u.role
        FROM ${t.pushSubscription} d
        JOIN ${t.userRole} u ON u.emp_no = d.emp_no
        WHERE u.active = ? AND u.locked = ? AND u.role IN ('MANAGER', 'KEEPER')
          AND EXISTS (
            SELECT 1 FROM ${t.outboundLine} l
            LEFT JOIN ${t.outboundPick} p ON p.scm_out_detail_id = l.scm_out_detail_id
            LEFT JOIN ${t.slots} s ON s.code = p.slot_code
            WHERE l.sheet_no = ? AND l.completed_at IS NULL
              AND ${outboundRecipientPredicate('d.emp_no', 'u.role')}
          )
    `, [true, false, sheetNo]);
    return rows;
}

module.exports = { save, remove, removeExpired, findRecipients };
