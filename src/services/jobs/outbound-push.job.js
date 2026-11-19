'use strict';

const { createHash, randomUUID } = require('node:crypto');
const webPush = require('web-push');
const { redis: config } = require('../../config/worker.config');
const { getProducerRedisConnection } = require('../../util/worker/redis');
const { getProducerQueue } = require('../../util/worker/queue');
const { createWorkerLogger } = require('../../util/worker/logger');
const subscriptions = require('../../repository/sql/push-subscription.repository');
const { notifications } = require('../outbound.service');
const { validEndpoint, vapidConfig } = require('../push-device.service');

const QUEUE_NAME = 'outbound-push';
const DELIVERY_TTL = 30 * 24 * 60 * 60;
const CLAIM_TTL = 120;
const DELIVERY_CONCURRENCY = 8;
const logger = createWorkerLogger(QUEUE_NAME);
const UPDATE_CLAIM = `
    if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
    if ARGV[2] == 'sent' then
        return redis.call('SET', KEYS[1], 'sent', 'EX', ARGV[3])
    end
    return redis.call('DEL', KEYS[1])
`;

async function enqueueOutboundPush(sheetNo) {
    if (!vapidConfig()) return;
    await getProducerQueue(QUEUE_NAME).add('notify', { sheetNo });
}

function payloadFor(notice) {
    const { sheetNo, lines } = notice;
    const line = lines[0];
    const clipped = (value, size) => String(value || '').slice(0, size);
    const poNumbers = line.poNumbers.slice(0, 3).map((po) => clipped(po, 50));
    const po = poNumbers.length ? poNumbers.join(', ') : 'Chưa xác định PO';
    const shelves = [...new Set(line.picks.map((pick) => pick.shelfCode).filter(Boolean))];
    const url = `/outbound?sheet=${encodeURIComponent(sheetNo)}`;
    return JSON.stringify({
        title: `Phiếu xuất ${sheetNo}`,
        body: [
            `PO: ${po}`,
            `NPL: ${line.goodsNo} · Lot: ${line.madeLot}`,
            `Kệ: ${shelves.length ? shelves.join(', ') : 'Chưa có kệ đề xuất'}`,
            `Số lượng: ${line.requestedQty} ${line.unit || ''}`.trim(),
            lines.length > 1 ? `+${lines.length - 1} dòng hàng · Mở phiếu để xem` : '',
        ].filter(Boolean).join('\n'),
        tag: `outbound-${sheetNo}`,
        sheetNo,
        url,
        data: { sheetNo, url },
    });
}

async function deliver(redis, device, sheetNo, payload, vapidDetails) {
    if (!validEndpoint(device.endpoint)) return 'invalid_endpoint';
    const hash = createHash('sha256').update(JSON.stringify([device.emp_no, device.id, sheetNo])).digest('hex');
    const key = `${config.prefix}:outbound:push:${hash}`;
    const claim = randomUUID();
    if (!await redis.set(key, claim, 'EX', CLAIM_TTL, 'NX')) return 'deduplicated';

    try {
        await webPush.sendNotification({
            endpoint: device.endpoint,
            keys: { p256dh: device.p256dh, auth: device.auth },
        }, payload, { vapidDetails, timeout: 5000, TTL: 3600 });
    } catch (error) {
        await redis.eval(UPDATE_CLAIM, 1, key, claim, 'release', DELIVERY_TTL);
        if (error.statusCode === 404 || error.statusCode === 410) {
            await subscriptions.removeExpired(device);
            return 'expired';
        }
        logger.warn('push_provider_error', {
            sheetNo, empNo: device.emp_no, subscriptionId: device.id,
            platform: device.platform, statusCode: error.statusCode ?? null,
        });
        throw new Error('outbound_push_provider_failed');
    }

    await redis.eval(UPDATE_CLAIM, 1, key, claim, 'sent', DELIVERY_TTL);
    return 'sent';
}

async function processOutboundPush(job) {
    const vapid = vapidConfig();
    if (!vapid) throw new Error('outbound_push_not_configured');
    const { sheetNo } = job.data;
    const redis = getProducerRedisConnection();
    const recipients = await subscriptions.findRecipients(sheetNo);
    let failures = 0;
    let sent = 0;
    const notices = new Map();
    let skipped = 0;
    for (let offset = 0; offset < recipients.length; offset += DELIVERY_CONCURRENCY) {
        await Promise.all(recipients.slice(offset, offset + DELIVERY_CONCURRENCY).map(async (device) => {
            const context = {
                sheetNo, empNo: device.emp_no, subscriptionId: device.id,
                platform: device.platform,
            };
            try {
                if (!notices.has(device.emp_no)) {
                    notices.set(device.emp_no,
                        notifications({ id: device.emp_no, role: device.role }, sheetNo)
                            .then(([notice]) => notice?.lines.length ? payloadFor(notice) : null));
                }
                const payload = await notices.get(device.emp_no);
                const result = payload
                    ? await deliver(redis, device, sheetNo, payload, vapid) : 'no_visible_lines';
                if (result === 'sent') sent += 1;
                else skipped += 1;
                logger.info('outbound_push_device_result', { ...context, result });
            } catch {
                failures += 1;
                logger.error('outbound_push_device_failed', context);
            }
        }));
    }
    logger.info('outbound_push_result', { sheetNo, recipients: recipients.length, sent, skipped, failures });
    if (failures) throw new Error('outbound_push_delivery_failed');
    return { sent };
}

module.exports = { QUEUE_NAME, enqueueOutboundPush, processOutboundPush };
