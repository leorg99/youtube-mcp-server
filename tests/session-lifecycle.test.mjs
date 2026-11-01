import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function server(t, { mode = 'stateless', limit = 20, fixture, stalled = false } = {}) {
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const logs = [];
  const child = spawn(
    process.execPath,
    [...(fixture ? ['--import', `./tests/fixtures/${fixture}.mjs`] : []), 'dist/http-server.js'],
    {
      env: {
        ...process.env,
        PORT: String(port),
        MCP_SESSION_MODE: mode,
        MAX_SESSIONS: String(limit),
        SESSION_IDLE_TIMEOUT_MS: '1000',
        SHUTDOWN_GRACE_MS: '100',
        TEST_STALLED_PROVIDER: stalled ? '1' : '0',
        YOUTUBE_API_KEY: '',
        MCP_BEARER_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (data) => logs.push(data.toString()));
  child.stderr.on('data', (data) => logs.push(data.toString()));
  const running = () => child.exitCode === null && child.signalCode === null;
  t.after(async () => {
    if (running()) {
      const exited = once(child, 'exit');
      child.kill();
      const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(timeout);
    }
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok) {
        break;
      }
    } catch {
      // The listener may not be ready yet; keep retrying within the startup bound.
    }
    if (!running()) {
      throw new Error(logs.join(''));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (i === 199) throw new Error(logs.join(''));
  }
  return {
    logs,
    base,
    child,
    metrics: async () => (await fetch(base + '/mcp/metrics')).json(),
    async connect() {
      const client = new Client({ name: 'session-test', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'));
      await client.connect(transport);
      return { client, transport };
    },
    post: (body, id, version = '2025-11-25') =>
      fetch(base + '/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': version,
          ...(id ? { 'Mcp-Session-Id': id } : {}),
        },
        body: JSON.stringify(body),
      }),
  };
}
const initialize = (id) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'raw-test', version: '1' },
  },
});

test('stateless sequential connector-style calls release every request, well beyond 20', async (t) => {
  const s = await server(t);
  for (let i = 0; i < 35; i++) {
    const { client, transport } = await s.connect();
    assert.equal(transport.sessionId, undefined);
    const list = await client.listTools();
    assert.ok(list.tools.find((tool) => tool.name === 'get-channel-uploads'));
    const result = await client.callTool({ name: 'search-videos', arguments: { query: 'test' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /YOUTUBE_API_KEY/);
    await client.close();
    const metrics = await s.metrics();
    assert.equal(metrics.activeSessions, 0);
    assert.equal(metrics.activeRequests, 0);
    assert.equal(metrics.rejected, 0);
  }
});

test('stateful requests reuse one session and DELETE releases it immediately', async (t) => {
  const s = await server(t, { mode: 'stateful' });
  const { client, transport } = await s.connect();
  for (let i = 0; i < 25; i++) await client.listTools();
  const metrics = await s.metrics();
  assert.equal(metrics.created, 1);
  assert.equal(metrics.activeSessions, 1);
  assert.ok(metrics.reused >= 25);
  await transport.terminateSession();
  await client.close();
  assert.equal((await s.metrics()).activeSessions, 0);
  assert.match(s.logs.join(''), /session_created/);
  assert.match(s.logs.join(''), /session_reused/);
  assert.match(s.logs.join(''), /session_closed/);
});

test('capacity errors correlate request ID and retain message/status through SDK caller', async (t) => {
  const s = await server(t, { mode: 'stateful', limit: 1 });
  const { client, transport } = await s.connect();
  const response = await s.post(initialize('capacity-test'));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.id, 'capacity-test');
  assert.equal(body.error.code, -32003);
  assert.equal(body.error.message, 'Session capacity reached. Try again later.');
  assert.deepEqual(body.error.data, { category: 'capacity', httpStatus: 503, retryable: true });
  await assert.rejects(s.connect(), /Session capacity reached\. Try again later\./);
  await transport.terminateSession();
  await client.close();
});

test('concurrent initializations cannot exceed reserved capacity', async (t) => {
  const s = await server(t, { mode: 'stateful', limit: 2 });
  const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => s.post(initialize(i))));
  assert.equal(replies.filter((r) => r.ok).length, 2);
  assert.equal((await s.metrics()).activeSessions, 2);
});

test('invalid initialization does not leak and abandoned sessions expire', async (t) => {
  const s = await server(t, { mode: 'stateful', limit: 1 });
  const invalid = initialize(1);
  invalid.params.clientInfo = null;
  await s.post(invalid);
  assert.equal((await s.metrics()).activeSessions, 0);
  assert.equal((await s.metrics()).pendingInitializations, 0);
  const response = await s.post(initialize(2));
  const id = response.headers.get('mcp-session-id');
  assert.ok(id);
  await response.text();
  for (let i = 0; i < 60; i++) {
    if ((await s.metrics()).activeSessions === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const metrics = await s.metrics();
  assert.equal(metrics.activeSessions, 0);
  assert.equal(metrics.expired, 1);
  assert.ok(!s.logs.join('').includes(id), 'never log raw routing/session credentials');
});

test('stateless concurrency is bounded and rejects work with useful errors', async (t) => {
  const s = await server(t, { limit: 1, fixture: 'slow-upload' });
  const { client } = await s.connect();
  const work = client.callTool({
    name: 'get-channel-uploads',
    arguments: { channelId: 'UCjZnbgPb08NFg7MHyPQRZ3Q' },
  });
  for (let i = 0; i < 50 && (await s.metrics()).activeRequests === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const second = await s.connect();
  const denied = await second.client.callTool({
    name: 'get-channel-uploads',
    arguments: { channelId: 'UCjZnbgPb08NFg7MHyPQRZ3Q' },
  });
  assert.equal(denied.isError, true);
  const error = JSON.parse(denied.content[0].text).error;
  assert.equal(error.message, 'Session capacity reached. Try again later.');
  assert.equal(error.httpStatus, 503);
  assert.equal(error.category, 'capacity');
  await second.client.close();
  await work;
  assert.equal((await s.metrics()).activeRequests, 0);
  assert.equal((await s.metrics()).activeSessions, 0);
  await client.close();
});

for (const mode of ['stateless', 'stateful']) {
  test(`${mode} rejects modern-protocol batches before dispatching provider work`, async (t) => {
    const s = await server(t, { mode, limit: 1, fixture: 'slow-upload' });
    const { client, transport } = await s.connect();
    const before = await s.metrics();
    const response = await s.post(
      Array.from({ length: 3 }, (_, id) => ({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: 'get-channel-uploads',
          arguments: { channelId: 'UCjZnbgPb08NFg7MHyPQRZ3Q' },
        },
      })),
      transport.sessionId,
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, -32600);
    assert.doesNotMatch(s.logs.join(''), /provider_started/);
    assert.equal((await s.metrics()).activeProviderRequests, 0);
    assert.equal((await s.metrics()).requestsClosed, before.requestsClosed);
    if (transport.sessionId) {
      await transport.terminateSession();
    }
    await client.close();
  });
}

test('SDK close rejection does not leak a stateless provider permit', async (t) => {
  const s = await server(t, { limit: 1, fixture: 'close-failure' });
  const { client } = await s.connect();
  for (let i = 0; i < 5; i++) {
    const result = await client.callTool({
      name: 'get-channel-uploads',
      arguments: { channelId: 'UCjZnbgPb08NFg7MHyPQRZ3Q' },
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.category, 'authentication');
    assert.equal((await s.metrics()).activeProviderRequests, 0);
  }
  const metrics = await s.metrics();
  assert.ok(metrics.cleanupFailures >= 5);
  assert.equal(metrics.rejected, 0);
  assert.equal(metrics.activeContexts, 0);
  assert.match(s.logs.join(''), /server_close_failed/);
  await client.close();
});

test(
  'shutdown aborts and bounds an uncooperative stateless request',
  { timeout: 5000 },
  async (t) => {
    const s = await server(t, { fixture: 'slow-upload', stalled: true });
    const { client } = await s.connect();
    const work = client
      .callTool({
        name: 'get-channel-uploads',
        arguments: { channelId: 'UCjZnbgPb08NFg7MHyPQRZ3Q' },
      })
      .catch((error) => error);
    for (let i = 0; i < 100 && !s.logs.join('').includes('provider_started'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(s.logs.join(''), /provider_started/);
    assert.equal((await s.metrics()).activeContexts, 1);
    const exit = once(s.child, 'exit');
    const started = Date.now();
    s.child.kill('SIGTERM');
    const [code, signal] = await exit;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.ok(Date.now() - started < 2000);
    assert.match(s.logs.join(''), /shutdown_timeout/);
    assert.match(s.logs.join(''), /provider_aborted/);
    assert.ok((await work) instanceof Error);
    await client.close();
  },
);

for (const mode of ['stateful', 'stateless']) {
  test(`${mode} releases capacity after failed SDK initialization`, async (t) => {
    const s = await server(t, { mode, limit: 1, fixture: 'connect-failure' });
    for (let id = 0; id < 3; id++) {
      const response = await s.post(initialize(id));
      assert.equal(response.status, 500);
      assert.equal((await response.json()).error.data.category, 'transport');
      const metrics = await s.metrics();
      assert.equal(metrics.activeContexts, 0);
      assert.equal(metrics.activeSessions, 0);
      assert.equal(metrics.activeProviderRequests, 0);
      assert.equal(metrics.pendingInitializations, 0);
      assert.equal(metrics.rejected, 0);
    }
  });
}

test('malformed MCP messages fail before allocating contexts', async (t) => {
  const s = await server(t);
  for (const body of [{ method: 'tools/call', id: 1 }, [], [initialize(1)]]) {
    const response = await s.post(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.data.category, 'invalid_arguments');
  }
  assert.equal((await s.metrics()).requestsClosed, 0);
});

test('invalid JSON exposes a safe parse error without echoing the request body', async (t) => {
  const s = await server(t);
  const response = await fetch(s.base + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"secret-key"',
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, -32700);
  assert.equal(body.error.data.category, 'invalid_arguments');
  assert.ok(!JSON.stringify(body).includes('secret-key'));
  assert.ok(!s.logs.join('').includes('secret-key'));
  assert.equal((await s.metrics()).activeContexts, 0);
});

test('legacy batches reserve capacity for every provider request before dispatch', async (t) => {
  const s = await server(t, { limit: 2, fixture: 'slow-upload' });
  const batch = Array.from({ length: 3 }, (_, id) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'get-channel-uploads',
      arguments: { channelId: 'UCjZnbgPb08NFg7MHyPQRZ3Q' },
    },
  }));
  const denied = await s.post(batch, undefined, '2025-03-26');
  assert.equal(denied.status, 200);
  const replies = await denied.json();
  assert.equal(replies.length, 3);
  for (const [index, reply] of replies.entries()) {
    assert.equal(reply.id, index);
    assert.equal(reply.result.structuredContent.error.category, 'capacity');
  }
  assert.doesNotMatch(s.logs.join(''), /provider_started/);
  const work = s.post(batch.slice(0, 2), undefined, '2025-03-26');
  for (let i = 0; i < 100 && (await s.metrics()).activeProviderRequests !== 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await s.metrics()).activeProviderRequests, 2);
  const blocked = await s.post(batch.slice(0, 1), undefined, '2025-03-26');
  assert.equal((await blocked.json())[0].result.isError, true);
  const completed = await (await work).json();
  assert.equal(completed.length, 2);
  assert.ok(completed.every((reply) => !reply.result.isError));
  assert.equal((await s.metrics()).activeProviderRequests, 0);
});
