'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const webPush = require('web-push');
const redisModule = require('../src/util/worker/redis');
const subscriptions = require('../src/repository/sql/push-subscription.repository');
const outbound = require('../src/services/outbound.service');
const devices = require('../src/services/push-device.service');

test('delivers to Android and iOS per device with bounded concurrency and independent retries', async (t) => {
    const logs = [];
    t.mock.method(console, 'log', (line) => logs.push(JSON.parse(line)));
    t.mock.method(console, 'error', (line) => logs.push(JSON.parse(line)));
    const claims = new Map();
    const redis = {
        async set(key, claim) {
            if (claims.has(key)) return null;
            claims.set(key, claim);
            return 'OK';
        },
        async eval(script, count, key, claim, action) {
            if (claims.get(key) !== claim) return 0;
            if (action === 'sent') claims.set(key, 'sent');
            else claims.delete(key);
            return 1;
        },
    };
    t.mock.method(redisModule, 'getProducerRedisConnection', () => redis);
    t.mock.method(devices, 'vapidConfig', () => ({ subject: 'mailto:it@example.com' }));
    const recipients = Array.from({ length: 19 }, (_, index) => ({
        id: String(index), emp_no: index < 2 ? 'SAME-ACCOUNT' : 'ACCOUNT-' + index,
        platform: index % 2 ? 'ios' : 'android', role: 'KEEPER',
        endpoint: index % 2 ? 'https://web.push.apple.com/' + index : 'https://fcm.googleapis.com/' + index,
        p256dh: 'test', auth: 'test',
    }));
    t.mock.method(subscriptions, 'findRecipients', async () => recipients);
    const expired = t.mock.method(subscriptions, 'removeExpired', async () => {});
    const noticeReads = t.mock.method(outbound, 'notifications', async (actor) => [{
        sheetNo: 'OUT-1',
        lines: [{
            goodsNo: actor.id, poNumbers: ['PO-1'], madeLot: 'LOT-1',
            requestedQty: 100, unit: 'YD', picks: [{ shelfCode: 'A' }],
        }],
    }]);
    let active = 0;
    let maxActive = 0;
    let failApple = true;
    const sentTo = [];
    t.mock.method(webPush, 'sendNotification', async (device, message) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
            await delay(3);
            if (device.endpoint.endsWith('/1') && failApple) {
                throw Object.assign(new Error('temporary provider failure'), { statusCode: 503 });
            }
            sentTo.push({ endpoint: device.endpoint, payload: JSON.parse(message) });
        } finally {
            active -= 1;
        }
    });
    const { processOutboundPush } = require('../src/services/jobs/outbound-push.job');
    await assert.rejects(processOutboundPush({ data: { sheetNo: 'OUT-1' } }), /outbound_push_delivery_failed/);
    assert.equal(sentTo.length, 18);
    assert.ok(maxActive > 1 && maxActive <= 8);
    assert.equal(noticeReads.mock.callCount(), 18);
    assert.equal(sentTo.filter(({ endpoint }) => endpoint.endsWith('/0')).length, 1);
    assert.ok(sentTo.every(({ payload }) => payload.body.includes('Số lượng: 100 YD')));

    failApple = false;
    assert.equal((await processOutboundPush({ data: { sheetNo: 'OUT-1' } })).sent, 1);
    assert.equal(sentTo.length, 19);
    assert.equal(new Set(sentTo.map(({ endpoint }) => endpoint)).size, 19);
    assert.equal((await processOutboundPush({ data: { sheetNo: 'OUT-1' } })).sent, 0);

    recipients.push({
        ...recipients[1], id: 'expired-ios', endpoint: 'https://web.push.apple.com/expired',
    });
    t.mock.method(webPush, 'sendNotification', async () => {
        throw Object.assign(new Error('expired subscription'), { statusCode: 410 });
    });
    assert.equal((await processOutboundPush({ data: { sheetNo: 'OUT-1' } })).sent, 0);
    assert.equal(expired.mock.callCount(), 1);
    assert.equal(expired.mock.calls[0].arguments[0].id, 'expired-ios');
    assert.ok(logs.some((log) => log.event === 'outbound_push_device_result'
        && log.platform === 'android' && log.result === 'sent'));
    assert.ok(logs.some((log) => log.event === 'outbound_push_device_result'
        && log.platform === 'ios' && log.result === 'sent'));
    assert.ok(logs.some((log) => log.event === 'push_provider_error'
        && log.platform === 'ios' && log.statusCode === 503));
});
