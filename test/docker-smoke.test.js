'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:3000';

test('Docker API smoke: health, auth, protected data and docs', async () => {
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const denied = await fetch(`${baseUrl}/api/warehouse/slots`);
  assert.equal(denied.status, 401);

  const login = await fetch(`${baseUrl}/api/warehouse/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ empNo: 'TEST-MGR', password: '123456' }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  assert.ok(token);

  const slots = await fetch(`${baseUrl}/api/warehouse/slots`, {
    headers: { 'x-auth-token': token },
  });
  assert.equal(slots.status, 200);
  assert.ok(await slots.json());

  const docs = await fetch(`${baseUrl}/api-docs.json`);
  assert.equal(docs.status, 200);
  assert.ok((await docs.json()).paths);
});
