import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function server(t, mode = 'stateless', limit = 20, slow = false) {
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const logs = [];
  const child = spawn(process.execPath, [...(slow ? ['--import', './tests/fixtures/slow-upload.mjs'] : []), 'dist/http-server.js'], {
    env: { ...process.env, PORT: String(port), MCP_SESSION_MODE: mode, MAX_SESSIONS: String(limit),
      SESSION_IDLE_TIMEOUT_MS: '1000', YOUTUBE_API_KEY: '', MCP_BEARER_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => logs.push(data.toString()));
  child.stderr.on('data', (data) => logs.push(data.toString()));
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(base + '/health')).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (i === 199) throw new Error(logs.join(''));
  }
  return {
    logs,
    metrics: async () => (await fetch(base + '/mcp/metrics')).json(),
    async connect() {
      const client = new Client({ name: 'session-test', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'));
      await client.connect(transport);
      return { client, transport };
    },
    post: (body, id) => fetch(base + '/mcp', { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(id ? { 'Mcp-Session-Id': id } : {}),
    }, body: JSON.stringify(body) }),
  };
}
const initialize = (id) => ({ jsonrpc: '2.0', id, method: 'initialize', params: {
  protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw-test', version: '1' },
} });

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
  const s = await server(t, 'stateful');
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
  const s = await server(t, 'stateful', 1);
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
  const s = await server(t, 'stateful', 2);
  const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => s.post(initialize(i))));
  assert.equal(replies.filter((r) => r.ok).length, 2);
  assert.equal((await s.metrics()).activeSessions, 2);
});

test('invalid initialization does not leak and abandoned sessions expire', async (t) => {
  const s = await server(t, 'stateful', 1);
  const invalid = initialize(1); invalid.params.clientInfo = null;
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
  const s = await server(t, 'stateless', 1, true);
  const { client } = await s.connect();
  const work = client.callTool({ name: 'get-channel-uploads', arguments: { channelId: 'UCjZnbgPb08NFg7MHyPQRZ3Q' } });
  for (let i = 0; i < 50 && (await s.metrics()).activeRequests === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const second = await s.connect();
  const denied = await second.client.callTool({ name: 'get-channel-uploads',
    arguments: { channelId: 'UCjZnbgPb08NFg7MHyPQRZ3Q' } });
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
