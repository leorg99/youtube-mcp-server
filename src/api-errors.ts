/** Safe diagnostics never include request URLs or raw provider error objects. */
export type ErrorCategory =
  | 'authentication'
  | 'capacity'
  | 'invalid_arguments'
  | 'not_found'
  | 'session'
  | 'shutdown'
  | 'transport'
  | 'youtube_api';

export interface DiagnosticError {
  category: ErrorCategory;
  code: string | number | null;
  message: string;
  httpStatus: number | null;
  retryable: boolean;
  reasons?: string[];
}

export const CAPACITY_ERROR: DiagnosticError = {
  category: 'capacity',
  code: -32003,
  message: 'Session capacity reached. Try again later.',
  httpStatus: 503,
  retryable: true,
};

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const AUTHENTICATION_REASONS = new Set([
  'keyInvalid',
  'accessNotConfigured',
  'ipRefererBlocked',
  'forbidden',
  'SERVICE_DISABLED',
]);
const LOCAL_MESSAGES: Record<string, string> = {
  API_KEY_REQUIRED: 'This tool requires a YouTube API key (YOUTUBE_API_KEY).',
  CHANNEL_NOT_FOUND: 'Channel not found or uploads playlist unavailable.',
  INVALID_CHANNEL_ID: 'Invalid channel ID.',
  INVALID_PAGE_SIZE: 'maxResults must be an integer between 1 and 50.',
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function safeCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z_]{1,128}$/.test(value) ? value : null;
}

function providerReasons(provider: Record<string, unknown>): string[] {
  const entries = [provider.errors, provider.details].flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
  const reasons = entries
    .map((entry) => record(entry).reason)
    .filter(
      (reason): reason is string => typeof reason === 'string' && /^[\w.-]{1,128}$/.test(reason),
    );
  return [...new Set(reasons)].slice(0, 20);
}

function categoryFor(status: number | null, code: string | null, reasons: string[]): ErrorCategory {
  if (
    code === 'API_KEY_REQUIRED' ||
    status === 401 ||
    reasons.some((reason) => reason.startsWith('API_KEY_') || AUTHENTICATION_REASONS.has(reason))
  ) {
    return 'authentication';
  }
  if (status === 400 || code === 'INVALID_CHANNEL_ID' || code === 'INVALID_PAGE_SIZE') {
    return 'invalid_arguments';
  }
  if (status === 404 || code === 'CHANNEL_NOT_FOUND') {
    return 'not_found';
  }
  return status === null ? 'transport' : 'youtube_api';
}

export function toolError(error: DiagnosticError) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error }) }],
    structuredContent: { error: { ...error } },
  };
}

export function dataApiError(error: unknown): ReturnType<typeof toolError> {
  const value = record(error);
  const response = record(value.response);
  const rawStatus = response.status;
  const status =
    typeof rawStatus === 'number' &&
    Number.isInteger(rawStatus) &&
    rawStatus >= 100 &&
    rawStatus <= 599
      ? rawStatus
      : null;
  const provider = record(record(response.data).error);
  const reasons = providerReasons(provider);
  const localCode = safeCode(value.code);
  const code = safeCode(provider.status) ?? localCode;
  const category = categoryFor(status, localCode, reasons);
  let message = 'YouTube API request failed. Check API key configuration and network connectivity.';
  if (status !== null) {
    message = `YouTube API HTTP ${status}${reasons.length ? `: ${reasons.join(', ')}` : ''}.`;
  }
  if (localCode && Object.prototype.hasOwnProperty.call(LOCAL_MESSAGES, localCode)) {
    message = LOCAL_MESSAGES[localCode];
  }
  return toolError({
    category,
    code,
    message,
    httpStatus: status,
    reasons,
    retryable:
      category !== 'authentication' &&
      (status === 429 ||
        (status !== null && status >= 500) ||
        (localCode !== null && TRANSIENT_NETWORK_CODES.has(localCode))),
  });
}
