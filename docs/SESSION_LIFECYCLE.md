# HTTP sessions and channel uploads

The home-lab tunnel opened a new MCP session for successive invocations. With
20 retained sessions and a five-minute idle timeout, a short burst exhausted
capacity before the next tool handler ran. The server reused IDs when supplied;
there is no safe way for it to infer a shared logical caller from clientInfo,
an IP address, or a shared authorization credential. Those are not session IDs.
The tunnel/client implementation is external to this repository.

Set `MCP_SESSION_MODE=stateless` for this read-only, request/response deployment.
The standard SDK receives a fresh server/transport per request, does not issue
`Mcp-Session-Id`, and closes resources after each response. No conversation state
is needed by the tools. `MAX_SESSIONS` remains 20 in the deployment and bounds
concurrent provider work in this mode, rather than accumulating idle sessions.
GET/DELETE return 405 in stateless mode; the server offers no standalone SSE
notification stream or cross-request server callbacks there. Process-wide
transcript caching remains available.

Default `stateful` mode preserves compatibility with existing clients. Clients
must reuse `Mcp-Session-Id` and SHOULD DELETE it when finished. TCP/HTTP/SSE
closure alone is not session cancellation under the MCP specification. Explicit
DELETE, SDK transport closure, failed initialization, idle expiry, transport
failure and shutdown release state. Expiry excludes requests still in progress.
Concurrent initializations reserve capacity before asynchronous setup.

`GET /mcp/metrics` uses the same bearer authentication as `/mcp` and reports mode,
active sessions, temporary contexts, HTTP requests, provider requests, pending initializations, limits and lifecycle
counters. JSON logs report creation, reuse, closure, expiry, rejection and
incomplete HTTP responses, including termination reason and active counts.
Session identifiers and initialization client metadata are hashed. Client
metadata is diagnostic only, never authentication or a session-sharing key.
No API key, request argument, transcript or raw session token is logged.

Transport errors preserve HTTP status and JSON-RPC code, include an error
category/retryability, and echo the original request ID. Previously initialization
capacity errors incorrectly used id:null; the tunnel logged invalid_mcp_error
and the hosted caller saw only Internal error. A noncompliant external client
can still discard an upstream error; the server cannot control its UI.
Stateless overload during tools/call returns a standard isError tool result,
so clients can show its capacity message without treating it as a transport
crash. Initialization and discovery remain available during provider saturation.
YouTube tool failures return isError tool results with status/reason/category,
without serializing Google request objects that contain API credentials.

`get-channel-uploads` accepts channelId, maxResults (integer 1–50, default 10)
and pageToken. It resolves channels.list(contentDetails), reads the returned
relatedPlaylists.uploads ID, and calls playlistItems.list(snippet,contentDetails).
It never calls search.list or guesses an uploads playlist ID. Response items
preserve playlist order; nextPageToken is null on the final page. publishedAt is
the video's publication time; playlistAddedAt is the playlist insertion time.
Private/deleted entries can lack publication data. Shorts and archived streams
may appear; this is the uploads playlist, not the website's Videos tab alone.
Pagination is YouTube's opaque continuation, not a snapshot across new uploads.
The existing analyze-channel-videos tool continues to use its original search
and statistics sequence.

Run `npm test` for protocol, lifecycle, admission, errors and mocked Data API
coverage. Live acceptance additionally requires a hosted connector call and
checking metrics before/after more than 20 sequential invocations.

### Admission and shutdown guarantees

Prefer one MCP message per HTTP request. Protocol 2025-03-26 retains batch
support. Stateless batches reserve one permit per provider request before dispatch;
a batch exceeding available capacity is rejected in full, with correlated
capacity responses for requests and no responses for notifications. Permits are
held until the entire batch completes. Protocols 2025-06-18 and later reject
batches with HTTP 400 / JSON-RPC -32600 before dispatch.
Initialization, notifications and discovery do not consume provider permits.
Provider permits are released after work completes, even if SDK cleanup fails;
cleanup attempts the underlying transport as a fallback and records failures.
Closure counters increase only after cleanup succeeds.

On SIGTERM/SIGINT, the listener stops accepting new connections and active work
can drain for `SHUTDOWN_GRACE_MS` (default 10000 ms). Idle contexts close promptly.
At the deadline, all remaining contexts close, handler signals are aborted, HTTP
connections are destroyed, and the process exits even if a provider ignores
cancellation. Set the grace interval below the container termination grace.
Uploads forward the handler signal to both API requests, each with a 10-second
timeout and no automatic retries. Known transient network failures are marked
retryable; this reports retry policy without silently repeating requests.

`npm run format:check` checks the lifecycle/error modules and their tests without
reformatting unrelated upstream files. CI runs these checks and tests the packed
archive with a clean production dependency install in addition to source tests.
