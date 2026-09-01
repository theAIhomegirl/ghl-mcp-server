import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhlApiError, GhlClient, retryDelayMs } from '../src/client.ts';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test('buildUrl substitutes and encodes path params and repeats array query keys', () => {
  const client = new GhlClient({ apiKey: 'k', baseUrl: 'https://api.test' });
  const url = client.buildUrl('/contacts/{contactId}', { contactId: 'a b' }, { ids: ['1', '2'], limit: 5, skip: undefined });
  assert.equal(url.toString(), 'https://api.test/contacts/a%20b?ids=1&ids=2&limit=5');
  assert.throws(() => client.buildUrl('/contacts/{contactId}', {}), /Missing required path parameter "contactId"/);
});

test('request sends auth and Version headers and a JSON body', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { contact: { id: 'C1' } } }]);
  const client = new GhlClient({ apiKey: 'secret', baseUrl: 'https://api.test', fetchImpl });
  const data = await client.request({ method: 'POST', path: '/contacts/', version: '2021-07-28', body: { name: 'Kai' } });
  assert.deepEqual(data, { contact: { id: 'C1' } });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer secret');
  assert.equal(headers.Version, '2021-07-28');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.body, '{"name":"Kai"}');
});

test('request surfaces API errors with joined messages', async () => {
  const { fetchImpl } = fakeFetch([{ status: 422, body: { statusCode: 422, message: ['email must be an email', 'phone invalid'] } }]);
  const client = new GhlClient({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl });
  await assert.rejects(
    client.request({ method: 'GET', path: '/x', version: '2021-07-28' }),
    (error: unknown) => error instanceof GhlApiError && error.status === 422 && error.message === 'email must be an email; phone invalid',
  );
});

test('request retries once after a 429', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '0' } },
    { status: 200, body: { ok: 1 } },
  ]);
  const client = new GhlClient({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl });
  const data = await client.request({ method: 'GET', path: '/x', version: '2021-07-28' });
  assert.deepEqual(data, { ok: 1 });
  assert.equal(calls.length, 2);
});

test('retryDelayMs accepts seconds or an HTTP-date and never returns NaN', () => {
  const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
  assert.equal(retryDelayMs('2', now), 2000);
  assert.equal(retryDelayMs(null, now), 1000);
  assert.equal(retryDelayMs('   ', now), 1000);
  // RFC 9110 allows an HTTP-date; Number() on it yields NaN, and setTimeout(NaN) fires
  // at once with a runtime warning on the stdio log channel.
  assert.equal(retryDelayMs('Wed, 21 Oct 2026 07:28:03 GMT', now), 3000);
  assert.equal(retryDelayMs('not a date', now), 1000);
  assert.equal(retryDelayMs('9999', now), 5000, 'clamped to the max delay');
  assert.equal(retryDelayMs('Wed, 21 Oct 2020 07:28:00 GMT', now), 0, 'a past date means retry now');
});

test('a multipart binary field is uploaded as a file part, not as "[object Object]"', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { ok: 1 } }]);
  const client = new GhlClient({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl });
  await client.request({
    method: 'POST',
    path: '/medias/upload-file',
    version: '2021-07-28',
    contentType: 'multipart/form-data',
    body: { file: { base64: Buffer.from('csv,data').toString('base64'), filename: 'rows.csv', contentType: 'text/csv' }, name: 'rows' },
  });
  const form = calls[0].init.body as FormData;
  assert.ok(form instanceof FormData);
  const file = form.get('file');
  assert.ok(file instanceof File, 'binary fields must become a file part');
  assert.equal(file.name, 'rows.csv');
  assert.equal(file.type, 'text/csv');
  assert.equal(await file.text(), 'csv,data');
  assert.equal(form.get('name'), 'rows');
});

test('urlencoded arrays repeat the key, matching query-string encoding', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: {} }]);
  const client = new GhlClient({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl });
  await client.request({
    method: 'POST',
    path: '/oauth/token',
    version: '2021-07-28',
    contentType: 'application/x-www-form-urlencoded',
    body: { scope: ['a', 'b'], grant_type: 'code' },
  });
  assert.equal(String(calls[0].init.body), 'scope=a&scope=b&grant_type=code');
});
