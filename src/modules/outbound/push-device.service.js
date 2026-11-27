'use strict';

const { createHash, randomUUID, ECDH } = require('node:crypto');
const repo = require('./push-subscription.repository');
const { err, shared } = require('../../shared/shared');

// Đọc cấu hình VAPID dùng để gửi web push.
function vapidConfig() {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT;
    return publicKey && privateKey && subject
        ? { publicKey, privateKey, subject } : null;
}

// Trả cấu hình push cho ứng dụng khách.
function config() {
    const vapid = vapidConfig();
    if (!vapid) err('push_unavailable', 503);
    return { vapidPublicKey: vapid.publicKey };
}

// Kiểm tra địa chỉ nhận web push.
function validEndpoint(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 2048 || endpoint !== endpoint.trim()) return false;
    let url;
    try {
        url = new URL(endpoint);
    } catch {
        return false;
    }
    const host = url.hostname;
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
        (host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
            host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com'));
}

// Tạo mã băm để định danh địa chỉ nhận push.
function endpointHash(endpoint) {
    return createHash('sha256').update(endpoint).digest('hex');
}

// Kiểm tra định dạng khóa đăng ký push.
function validKey(key, size) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(key)) return false;
    const bytes = Buffer.from(key, 'base64url');
    return bytes.length === size && bytes.toString('base64url') === key.replace(/=+$/, '');
}

// Kiểm tra tài khoản thao tác kho còn hoạt động.
async function ensureActiveOperator(actorId) {
    const actor = await shared.getActor(actorId);
    if (!actor.active || !['KEEPER', 'MANAGER'].includes(actor.role)) err('no_permission', 403);
    return actor;
}

// Đăng ký thiết bị nhận thông báo.
async function register(actorId, body) {
    config();
    const actor = await ensureActiveOperator(actorId);
    const subscription = body?.subscription ?? body ?? {};
    const { endpoint } = subscription;
    const keys = subscription.keys ?? subscription;
    const platform = body?.platform ?? 'other';
    if (!validEndpoint(endpoint) || !validKey(keys?.p256dh, 65) || !validKey(keys?.auth, 16) ||
        !['android', 'ios', 'other'].includes(platform)) err('invalid_push_subscription');
    try {
        const point = Buffer.from(keys.p256dh, 'base64url');
        if (point[0] !== 4) err('invalid_push_subscription');
        ECDH.convertKey(point, 'prime256v1');
    } catch {
        err('invalid_push_subscription');
    }
    await repo.save({
        id: randomUUID(), empNo: actor.id, endpoint, hash: endpointHash(endpoint),
        p256dh: keys.p256dh, auth: keys.auth, platform,
    });
}

// Hủy đăng ký thiết bị nhận thông báo.
async function unregister(actorId, body) {
    const actor = await ensureActiveOperator(actorId);
    const endpoint = body?.endpoint ?? body?.subscription?.endpoint;
    if (!validEndpoint(endpoint)) err('invalid_push_subscription');
    await repo.remove(actor.id, endpointHash(endpoint));
}

module.exports = { config, register, unregister, validEndpoint, vapidConfig };
