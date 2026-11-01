/** Safe tool errors: preserve provider status/reason without request URLs or keys. */
export function dataApiError(error: unknown) {
  const value = error as {
    response?: { status?: number; data?: { error?: {
      status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[];
    } } };
    code?: string; message?: string;
  };
  const status = value?.response?.status ?? null;
  const provider = value?.response?.data?.error;
  const reasons = [...new Set([...(provider?.errors ?? []), ...(provider?.details ?? [])]
    .map((item) => item.reason)
    .filter((reason): reason is string => typeof reason === 'string' && /^[\w.-]+$/.test(reason)))];
  const authentication = value?.code === 'API_KEY_REQUIRED' || status === 401 || reasons.some((reason) =>
    reason.startsWith('API_KEY_') || ['keyInvalid', 'accessNotConfigured', 'ipRefererBlocked', 'forbidden', 'SERVICE_DISABLED'].includes(reason));
  const category = authentication ? 'authentication'
    : status === 400 ? 'invalid_arguments'
    : status === 404 || value?.code === 'CHANNEL_NOT_FOUND' ? 'not_found'
    : status ? 'youtube_api' : 'transport';
  const rawCode = provider?.status ?? value?.code;
  const code = typeof rawCode === 'string' && /^[A-Z_]+$/.test(rawCode) ? rawCode : null;
  const message = value?.code === 'API_KEY_REQUIRED' ? 'This tool requires a YouTube API key (YOUTUBE_API_KEY).'
    : value?.code === 'CHANNEL_NOT_FOUND' ? 'Channel not found or uploads playlist unavailable.'
    : status ? `YouTube API HTTP ${status}${reasons.length ? `: ${reasons.join(', ')}` : ''}.`
    : 'YouTube API request failed. Check API key configuration and network connectivity.';
  return { isError: true, content: [{ type: 'text' as const,
    text: JSON.stringify({ error: { category, code, message, httpStatus: status, reasons,
      retryable: status === 429 || status !== null && status >= 500 } }) }] };
}
