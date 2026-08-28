import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhlApiError, GhlClient } from '../src/client.ts';

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
