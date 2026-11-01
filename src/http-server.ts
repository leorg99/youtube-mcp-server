#!/usr/bin/env node
import { config as loadEnvironment } from 'dotenv';
import express from 'express';
import cors from 'cors';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import createServer, { configSchema } from './index.js';

loadEnvironment({ quiet: true });

interface SessionContext {
  server: ReturnType<typeof createServer>;
  transport: StreamableHTTPServerTransport;
  lastAccessedAt: number;
  activeRequests: number;
  closed: boolean;
  logId: string;
  clientId?: string;
  terminationReason?: string;
}

const portRaw = process.env.PORT ?? '3000';
const port = Number(portRaw);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid PORT value: ${portRaw}`);
  process.exit(1);
}

const youtubeApiKey = process.env.YOUTUBE_API_KEY;
const bearerToken = process.env.MCP_BEARER_TOKEN;
const maxSessions = Number(process.env.MAX_SESSIONS ?? '100');
const sessionMode = process.env.MCP_SESSION_MODE ?? 'stateful';
if (!['stateful', 'stateless'].includes(sessionMode)) {
  throw new Error('MCP_SESSION_MODE must be stateful or stateless.');
}
const sessionIdleTimeoutMs = Number(process.env.SESSION_IDLE_TIMEOUT_MS ?? '1800000');

function parseCorsOrigins(value: string | undefined): Set<string> {
  if (!value) {
    return new Set();
  }

  const origins = value.split(',').map((origin) => origin.trim()).filter(Boolean);
  return new Set(origins.map((origin) => {
    if (origin === '*') {
      throw new Error('CORS_ORIGIN must list explicit origins; wildcard access is not supported.');
    }

    const parsed = new URL(origin);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }

    return parsed.origin;
  }));
}

let allowedCorsOrigins: Set<string>;
try {
  allowedCorsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid CORS_ORIGIN configuration.');
  process.exit(1);
}

if (!Number.isInteger(maxSessions) || maxSessions < 1) {
  console.error('MAX_SESSIONS must be a positive integer.');
  process.exit(1);
}

if (!Number.isFinite(sessionIdleTimeoutMs) || sessionIdleTimeoutMs < 1000) {
  console.error('SESSION_IDLE_TIMEOUT_MS must be at least 1000.');
  process.exit(1);
}

const app = express();
const sessions = new Map<string, SessionContext>();

app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedCorsOrigins.has(origin));
  },
  exposedHeaders: ['Mcp-Session-Id']
}));

function tokensMatch(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
}

app.use('/mcp', (req, res, next) => {
  if (!bearerToken) {
    next();
    return;
  }

  const authorization = req.get('authorization');
  const providedToken = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';

  if (!tokensMatch(providedToken, bearerToken)) {
    rpcError(req, res, 401, -32002, 'Unauthorized.', 'authentication');
    return;
  }

  next();
});

function getSessionId(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) {
    return header[0];
  }

  return header;
}

function createServerForSession() {
  return createServer({
    config: configSchema.parse({
      youtubeApiKey,
      port: String(port)
    })
  });
}

app.get('/', (_req, res) => {
  res.status(200).json({
    name: 'YouTube Research MCP',
    version: '2.0.1-lab.2',
    mcpEndpoint: '/mcp',
    healthEndpoint: '/health',
    documentation: 'https://github.com/coyaSONG/youtube-mcp-server',
  });
});

// Session IDs are bearer-like routing credentials. Log only a one-way digest.
function logId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
let pendingInitializations = 0;
let activeRequests = 0;
let statelessRequests = 0;
const counters = { created: 0, reused: 0, closed: 0, expired: 0, rejected: 0, requestsClosed: 0 };
function lifecycle(event: string, context?: SessionContext, reason?: string) {
  console.log(JSON.stringify({ event, session: context?.logId, client: context?.clientId, reason,
    mode: sessionMode, activeSessions: sessions.size, activeRequests,
    pendingInitializations }));
}
function rpcError(req: express.Request, res: express.Response, status: number,
  code: number, message: string, category: string, retryable = false) {
  // Correlate errors to the request. id:null made the tunnel reject otherwise
  // meaningful upstream errors as invalid_mcp_error during initialization.
  const id = typeof req.body?.id === 'number' || typeof req.body?.id === 'string'
    ? req.body.id : null;
  if (retryable) res.set('Retry-After', '1');
  res.status(status).json({ jsonrpc: '2.0', id,
    error: { code, message, data: { category, httpStatus: status, retryable } } });
}
function rejectCapacity(req: express.Request, res: express.Response) {
  counters.rejected += 1;
  lifecycle('session_rejected', undefined, 'capacity');
  rpcError(req, res, 503, -32003, 'Session capacity reached. Try again later.', 'capacity', true);
}
async function closeContext(context: SessionContext, reason: string) {
  if (context.closed) return;
  context.closed = true;
  if (context.transport.sessionId) sessions.delete(context.transport.sessionId);
  if (sessionMode === 'stateful') counters.closed += 1;
  else counters.requestsClosed += 1;
  if (reason === 'idle_timeout') counters.expired += 1;
  lifecycle(sessionMode === 'stateless' ? 'request_closed'
    : reason === 'idle_timeout' ? 'session_expired' : 'session_closed', context, reason);
  // Mark closed/remove before closing the SDK: its onclose callback can reenter.
  await context.server.close();
}
function newContext(stateful: boolean): SessionContext {
  const server = createServerForSession();
  const context: SessionContext = {
    server, lastAccessedAt: Date.now(), activeRequests: 0, closed: false,
    logId: logId(randomUUID()),
    transport: new StreamableHTTPServerTransport({
      sessionIdGenerator: stateful ? () => randomUUID() : undefined,
      enableJsonResponse: !stateful,
      onsessioninitialized: (id) => {
        context.logId = logId(id);
        sessions.set(id, context);
        counters.created += 1;
        lifecycle('session_created', context);
      },
    }),
  };
  context.transport.onclose = () => { void closeContext(context, context.terminationReason ?? 'transport_closed'); };
  return context;
}
async function handle(context: SessionContext, req: express.Request, res: express.Response) {
  context.lastAccessedAt = Date.now();
  context.activeRequests += 1;
  activeRequests += 1;
  const disconnected = () => {
    if (!res.writableFinished) lifecycle('transport_disconnected', context, 'response_incomplete');
    // An HTTP/SSE disconnection does not cancel a stateful MCP session (MCP spec).
  };
  res.on('close', disconnected);
  try {
    await context.transport.handleRequest(req, res, req.body);
  } finally {
    res.off('close', disconnected);
    context.activeRequests -= 1;
    activeRequests -= 1;
    context.lastAccessedAt = Date.now();
  }
}

app.post('/mcp', async (req, res) => {
  if (sessionMode === 'stateless') {
    // Initialization/discovery perform no provider work and must remain available
    // so overloaded tool invocations can return a standard isError tool result.
    const controlMethods = ['initialize', 'notifications/initialized', 'ping',
      'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list'];
    const providerWork = !controlMethods.includes(req.body?.method);
    if (providerWork && statelessRequests >= maxSessions) {
      if (req.body?.method === 'tools/call') {
        counters.rejected += 1;
        lifecycle('request_rejected', undefined, 'capacity');
        const error = { category: 'capacity', code: -32003, httpStatus: 503,
          retryable: true, message: 'Session capacity reached. Try again later.' };
        res.json({ jsonrpc: '2.0', id: req.body.id,
          result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] } });
      } else rejectCapacity(req, res);
      return;
    }
    if (providerWork) statelessRequests += 1;
    const context = newContext(false);
    if (isInitializeRequest(req.body)) {
      context.clientId = logId(JSON.stringify(req.body.params.clientInfo));
    }
    lifecycle('request_created', context);
    try {
      await context.server.connect(context.transport);
      await handle(context, req, res);
    } catch {
      lifecycle('request_failed', context, 'transport_error');
      if (!res.headersSent) rpcError(req, res, 500, -32603, 'MCP transport request failed.', 'transport');
    } finally {
      await closeContext(context, res.writableFinished ? 'request_complete' : 'request_failed');
      if (providerWork) statelessRequests -= 1;
    }
    return;
  }
  const sessionId = getSessionId(req.headers['mcp-session-id']);
  if (sessionId) {
    const context = sessions.get(sessionId);
    if (!context) { rpcError(req, res, 404, -32001, 'Session not found.', 'session'); return; }
    counters.reused += 1;
    lifecycle('session_reused', context);
    try { await handle(context, req, res); }
    catch {
      await closeContext(context, 'transport_error');
      if (!res.headersSent) rpcError(req, res, 500, -32603, 'MCP transport request failed.', 'transport');
    }
    return;
  }
  if (!isInitializeRequest(req.body)) {
    rpcError(req, res, 400, -32000, 'Initialization required before sending non-session requests.', 'session');
    return;
  }
  if (sessions.size + pendingInitializations >= maxSessions) { rejectCapacity(req, res); return; }
  // Reserve synchronously before connect() to prevent concurrent initialization races.
  pendingInitializations += 1;
  const context = newContext(true);
  context.clientId = logId(JSON.stringify(req.body.params.clientInfo));
  try {
    await context.server.connect(context.transport);
    await handle(context, req, res);
    if (res.statusCode >= 400 || !context.transport.sessionId) await closeContext(context, 'initialization_failed');
  } catch {
    await closeContext(context, 'initialization_failed');
    if (!res.headersSent) rpcError(req, res, 500, -32603, 'MCP initialization failed.', 'transport');
  } finally { pendingInitializations -= 1; }
});

for (const method of ['get', 'delete'] as const) {
  app[method]('/mcp', async (req, res) => {
    if (sessionMode === 'stateless') {
      res.set('Allow', 'POST').status(405).end();
      return;
    }
    const id = getSessionId(req.headers['mcp-session-id']);
    const context = id ? sessions.get(id) : undefined;
    if (!context) {
      rpcError(req, res, id ? 404 : 400, -32001,
        id ? 'Session not found.' : 'Missing Mcp-Session-Id header.', 'session');
      return;
    }
    try {
      if (method === 'delete') context.terminationReason = 'client_delete';
      await handle(context, req, res);
      if (method === 'delete') await closeContext(context, 'client_delete');
    } catch {
      await closeContext(context, 'transport_error');
      if (!res.headersSent) rpcError(req, res, 500, -32603, 'MCP transport request failed.', 'transport');
    }
  });
}

// Same auth boundary as /mcp; no session IDs, client input, or credentials exposed.
app.get('/mcp/metrics', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ mode: sessionMode,
    activeSessions: sessions.size, activeRequests, pendingInitializations,
    maxSessions, ...counters });
});

app.get('/health', (_req, res) => {
  res.set('cache-control', 'no-store');
  res.status(200).json({
    status: 'ok',
    mode: youtubeApiKey ? 'full' : 'transcript-only',
    capabilities: {
      transcriptResearch: true,
      youtubeDataApi: Boolean(youtubeApiKey),
    },
  });
});

const serverInstance = app.listen(port, () => {
  console.log(`YouTube Research MCP listening on port ${port}`);
  if (!youtubeApiKey) {
    console.log('Running in transcript-only mode. Set YOUTUBE_API_KEY to enable search, comments, and statistics.');
  }
});

const sessionCleanupTimer = setInterval(() => {
  const expirationTime = Date.now() - sessionIdleTimeoutMs;
  for (const context of sessions.values()) {
    if (context.activeRequests === 0 && context.lastAccessedAt < expirationTime) {
      void closeContext(context, 'idle_timeout').catch(() => lifecycle('cleanup_failed'));
    }
  }
}, Math.min(60_000, sessionIdleTimeoutMs));
sessionCleanupTimer.unref();

async function shutdown() {
  clearInterval(sessionCleanupTimer);
  await Promise.allSettled([...sessions.values()].map((context) => closeContext(context, 'shutdown')));
  serverInstance.close(() => process.exit(0));
}

process.on('SIGINT', () => {
  void shutdown();
});

process.on('SIGTERM', () => {
  void shutdown();
});
