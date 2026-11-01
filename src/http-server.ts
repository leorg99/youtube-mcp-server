#!/usr/bin/env node
import { config as loadEnvironment } from 'dotenv';
import express from 'express';
import cors from 'cors';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  isInitializeRequest,
  isJSONRPCRequest,
  JSONRPCMessageSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import createServer, { configSchema } from './index.js';
import { CAPACITY_ERROR, toolError, type ErrorCategory } from './api-errors.js';
import { SERVER_VERSION } from './version.js';

loadEnvironment({ quiet: true });

interface SessionContext {
  server: ReturnType<typeof createServer>;
  transport: StreamableHTTPServerTransport;
  lastAccessedAt: number;
  activeRequests: number;
  closePromise?: Promise<void>;
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
const shutdownGraceMs = Number(process.env.SHUTDOWN_GRACE_MS ?? '10000');
if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 1) {
  throw new Error('SHUTDOWN_GRACE_MS must be a positive safe integer.');
}

const sessionIdleTimeoutMs = Number(process.env.SESSION_IDLE_TIMEOUT_MS ?? '1800000');

function parseCorsOrigins(value: string | undefined): Set<string> {
  if (!value) {
    return new Set();
  }

  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set(
    origins.map((origin) => {
      if (origin === '*') {
        throw new Error(
          'CORS_ORIGIN must list explicit origins; wildcard access is not supported.',
        );
      }

      const parsed = new URL(origin);
      if (
        (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== '/' ||
        parsed.search ||
        parsed.hash
      ) {
        throw new Error(`Invalid CORS origin: ${origin}`);
      }

      return parsed.origin;
    }),
  );
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
// Includes temporary stateless contexts and initializing stateful sessions.
const contexts = new Set<SessionContext>();
let shuttingDown = false;

app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || allowedCorsOrigins.has(origin));
    },
    exposedHeaders: ['Mcp-Session-Id'],
  }),
);

function tokensMatch(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
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
      port: String(port),
    }),
  });
}

app.get('/', (_req, res) => {
  res.status(200).json({
    name: 'YouTube Research MCP',
    version: SERVER_VERSION,
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
const counters = {
  created: 0,
  reused: 0,
  closed: 0,
  expired: 0,
  rejected: 0,
  requestsClosed: 0,
  cleanupFailures: 0,
};

function lifecycle(event: string, context?: SessionContext, reason?: string) {
  console.log(
    JSON.stringify({
      event,
      session: context?.logId,
      client: context?.clientId,
      reason,
      mode: sessionMode,
      activeSessions: sessions.size,
      activeRequests,
      activeProviderRequests: statelessRequests,
      pendingInitializations,
    }),
  );
}

function rpcError(
  req: express.Request,
  res: express.Response,
  status: number,
  code: number,
  message: string,
  category: ErrorCategory,
  retryable = false,
) {
  // Initialization errors must carry the request ID so the connector can read them.
  const id =
    typeof req.body?.id === 'number' || typeof req.body?.id === 'string' ? req.body.id : null;
  if (retryable) {
    res.set('Retry-After', '1');
  }
  res.status(status).json({
    jsonrpc: '2.0',
    id,
    error: { code, message, data: { category, httpStatus: status, retryable } },
  });
}

function rejectCapacity(req: express.Request, res: express.Response) {
  counters.rejected += 1;
  lifecycle('session_rejected', undefined, 'capacity');
  rpcError(req, res, 503, -32003, CAPACITY_ERROR.message, 'capacity', true);
}

async function disposeContext(context: SessionContext, reason: string): Promise<void> {
  if (context.transport.sessionId) {
    sessions.delete(context.transport.sessionId);
  }
  try {
    await context.server.close();
  } catch {
    counters.cleanupFailures += 1;
    lifecycle('cleanup_failed', context, 'server_close_failed');
    // A failed SDK close must not prevent closing its underlying transport.
    try {
      await context.transport.close();
    } catch {
      lifecycle('cleanup_failed', context, 'transport_close_failed');
      return;
    }
  } finally {
    contexts.delete(context);
  }
  if (sessionMode === 'stateful') {
    counters.closed += 1;
  } else {
    counters.requestsClosed += 1;
  }
  if (reason === 'idle_timeout') {
    counters.expired += 1;
    lifecycle('session_expired', context, reason);
  } else {
    lifecycle(sessionMode === 'stateless' ? 'request_closed' : 'session_closed', context, reason);
  }
}

function closeContext(context: SessionContext, reason: string): Promise<void> {
  // Assign before SDK callbacks can reenter, and let concurrent callers await cleanup.
  context.closePromise ??= Promise.resolve().then(() => disposeContext(context, reason));
  return context.closePromise;
}

function newContext(stateful: boolean): SessionContext {
  const server = createServerForSession();
  const context: SessionContext = {
    server,
    lastAccessedAt: Date.now(),
    activeRequests: 0,
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
  context.transport.onclose = () => {
    void closeContext(context, context.terminationReason ?? 'transport_closed');
  };
  contexts.add(context);
  return context;
}
async function handle(context: SessionContext, req: express.Request, res: express.Response) {
  context.lastAccessedAt = Date.now();
  context.activeRequests += 1;
  activeRequests += 1;
  const disconnected = () => {
    if (!res.writableFinished) {
      lifecycle('transport_disconnected', context, 'response_incomplete');
    }
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

const CONTROL_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
]);

async function handleStateless(req: express.Request, res: express.Response): Promise<void> {
  // Discovery remains available while provider work is at capacity.
  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const requests = messages.filter(isJSONRPCRequest);
  const providerCount = requests.filter((request) => !CONTROL_METHODS.has(request.method)).length;
  if (providerCount + statelessRequests > maxSessions) {
    counters.rejected += 1;
    lifecycle('request_rejected', undefined, 'capacity');
    if (Array.isArray(req.body)) {
      // Reject the entire batch before executing any operation. Notifications
      // have no reply; every request retains its original correlation ID.
      res.json(
        requests.map((request) =>
          request.method === 'tools/call'
            ? { jsonrpc: '2.0', id: request.id, result: toolError(CAPACITY_ERROR) }
            : {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                  code: -32003,
                  message: CAPACITY_ERROR.message,
                  data: { category: 'capacity', httpStatus: 503, retryable: true },
                },
              },
        ),
      );
    } else if (req.body.method === 'tools/call') {
      res.json({ jsonrpc: '2.0', id: req.body.id, result: toolError(CAPACITY_ERROR) });
    } else {
      rpcError(req, res, 503, -32003, CAPACITY_ERROR.message, 'capacity', true);
    }
    return;
  }
  statelessRequests += providerCount;
  let context: SessionContext | undefined;
  try {
    context = newContext(false);
    if (isInitializeRequest(req.body)) {
      context.clientId = logId(JSON.stringify(req.body.params.clientInfo));
    }
    lifecycle('request_created', context);
    await context.server.connect(context.transport);
    await handle(context, req, res);
  } catch {
    lifecycle('request_failed', context, 'transport_error');
    if (!res.headersSent) {
      rpcError(req, res, 500, -32603, 'MCP transport request failed.', 'transport');
    }
  } finally {
    // Admission covers provider work, not asynchronous SDK disposal. Even a
    // cleanup failure must release the permit after the provider has finished.
    statelessRequests -= providerCount;
    if (context) {
      await closeContext(context, res.writableFinished ? 'request_complete' : 'request_failed');
    }
  }
}

async function handleStateful(req: express.Request, res: express.Response): Promise<void> {
  const sessionId = getSessionId(req.headers['mcp-session-id']);
  if (sessionId) {
    const context = sessions.get(sessionId);
    if (!context) {
      rpcError(req, res, 404, -32001, 'Session not found.', 'session');
      return;
    }
    counters.reused += 1;
    lifecycle('session_reused', context);
    try {
      await handle(context, req, res);
    } catch {
      await closeContext(context, 'transport_error');
      if (!res.headersSent) {
        rpcError(req, res, 500, -32603, 'MCP transport request failed.', 'transport');
      }
    }
    return;
  }
  const initialization = Array.isArray(req.body) && req.body.length === 1 ? req.body[0] : req.body;
  if (!isInitializeRequest(initialization)) {
    rpcError(
      req,
      res,
      400,
      -32000,
      'Initialization required before sending non-session requests.',
      'session',
    );
    return;
  }
  if (contexts.size >= maxSessions) {
    rejectCapacity(req, res);
    return;
  }
  pendingInitializations += 1;
  let context: SessionContext | undefined;
  try {
    // Synchronous creation tracks capacity before the first await, without
    // counting a registered-but-still-initializing session twice.
    context = newContext(true);
    context.clientId = logId(JSON.stringify(initialization.params.clientInfo));
    await context.server.connect(context.transport);
    await handle(context, req, res);
    if (res.statusCode >= 400 || !context.transport.sessionId) {
      await closeContext(context, 'initialization_failed');
    }
  } catch {
    if (context) {
      await closeContext(context, 'initialization_failed');
    }
    if (!res.headersSent) {
      rpcError(req, res, 500, -32603, 'MCP initialization failed.', 'transport');
    }
  } finally {
    pendingInitializations -= 1;
  }
}

app.post('/mcp', async (req, res) => {
  if (shuttingDown) {
    rpcError(
      req,
      res,
      503,
      -32004,
      'MCP server is shutting down. Try again later.',
      'shutdown',
      true,
    );
    return;
  }
  const batch = Array.isArray(req.body);
  const version = req.get('MCP-Protocol-Version') ?? '2025-03-26';
  if (batch && version >= '2025-06-18') {
    rpcError(
      req,
      res,
      400,
      -32600,
      'Batch requests are not supported by this MCP protocol version.',
      'invalid_arguments',
    );
    return;
  }
  const messages = batch ? req.body : [req.body];
  if (
    messages.length === 0 ||
    messages.length > 100 ||
    !messages.every((message: unknown) => JSONRPCMessageSchema.safeParse(message).success)
  ) {
    rpcError(
      req,
      res,
      400,
      -32600,
      'Invalid MCP message or batch size (maximum 100).',
      'invalid_arguments',
    );
    return;
  }
  if (sessionMode === 'stateless') {
    await handleStateless(req, res);
  } else {
    await handleStateful(req, res);
  }
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
      rpcError(
        req,
        res,
        id ? 404 : 400,
        -32001,
        id ? 'Session not found.' : 'Missing Mcp-Session-Id header.',
        'session',
      );
      return;
    }
    try {
      if (method === 'delete') {
        context.terminationReason = 'client_delete';
      }
      await handle(context, req, res);
      if (method === 'delete') {
        await closeContext(context, 'client_delete');
      }
    } catch {
      await closeContext(context, 'transport_error');
      if (!res.headersSent) {
        rpcError(req, res, 500, -32603, 'MCP transport request failed.', 'transport');
      }
    }
  });
}

// Same auth boundary as /mcp; no session IDs, client input, or credentials exposed.
app.get('/mcp/metrics', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    mode: sessionMode,
    activeSessions: sessions.size,
    activeContexts: contexts.size,
    activeRequests,
    activeProviderRequests: statelessRequests,
    pendingInitializations,
    maxSessions,
    ...counters,
  });
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

// Express parser failures also use safe JSON-RPC diagnostics, never an HTML
// stack trace containing the request body.
app.use(
  (error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const type = error !== null && typeof error === 'object' && 'type' in error ? error.type : null;
    if (type === 'entity.parse.failed') {
      rpcError(req, res, 400, -32700, 'Invalid JSON request body.', 'invalid_arguments');
    } else if (type === 'entity.too.large') {
      rpcError(req, res, 413, -32600, 'MCP request body exceeds 4 MB.', 'invalid_arguments');
    } else {
      lifecycle('request_failed', undefined, 'http_error');
      rpcError(req, res, 500, -32603, 'MCP HTTP request failed.', 'transport');
    }
  },
);

const serverInstance = app.listen(port, () => {
  console.log(`YouTube Research MCP listening on port ${port}`);
  if (!youtubeApiKey) {
    console.log(
      'Running in transcript-only mode. Set YOUTUBE_API_KEY to enable search, comments, and statistics.',
    );
  }
});

const sessionCleanupTimer = setInterval(
  () => {
    const expirationTime = Date.now() - sessionIdleTimeoutMs;
    for (const context of sessions.values()) {
      if (context.activeRequests === 0 && context.lastAccessedAt < expirationTime) {
        void closeContext(context, 'idle_timeout');
      }
    }
  },
  Math.min(60_000, sessionIdleTimeoutMs),
);
sessionCleanupTimer.unref();

function shutdown(): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearInterval(sessionCleanupTimer);
  lifecycle('shutdown_started');
  const deadline = setTimeout(() => {
    lifecycle('shutdown_timeout', undefined, 'drain_deadline');
    // SDK close aborts handler signals. Force HTTP connections closed as well:
    // an uncooperative provider may never settle the SDK response promise.
    for (const context of contexts) {
      void closeContext(context, 'shutdown_timeout');
    }
    serverInstance.closeAllConnections();
    setImmediate(() => process.exit(0));
  }, shutdownGraceMs);
  serverInstance.close(() => {
    void Promise.all([...contexts].map((context) => closeContext(context, 'shutdown'))).then(() => {
      clearTimeout(deadline);
      lifecycle('shutdown_complete');
      process.exit(0);
    });
  });
  // Idle stateful/SSE transports need not occupy the whole drain interval.
  for (const context of contexts) {
    if (context.activeRequests === 0) {
      void closeContext(context, 'shutdown');
    }
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
