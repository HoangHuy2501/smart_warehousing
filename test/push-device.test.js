'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validEndpoint } = require('../src/modules/outbound/push-device.service');

test('accepts HTTPS delivery endpoints for supported browsers', () => {
    assert.equal(validEndpoint('https://fcm.googleapis.com/fcm/send/test'), true);
    assert.equal(validEndpoint('https://web.push.apple.com/test'), true);
    assert.equal(validEndpoint('https://updates.push.services.mozilla.com/wpush/v2/test'), true);
});

test('rejects private hosts, lookalikes and unexpected transport or credentials', () => {
    for (const endpoint of [
        'https://127.0.0.1/test',
        'https://push.apple.com.example.com/test',
        'https://fcm.googleapis.com@127.0.0.1/test',
        'https://fcm.googleapis.com:8443/test',
        'http://fcm.googleapis.com/test',
        'https://user:password@fcm.googleapis.com/test',
    ]) assert.equal(validEndpoint(endpoint), false);
});
