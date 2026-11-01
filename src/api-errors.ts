/** Safe tool errors: preserve provider status/reason without request URLs or keys. */
export function dataApiError(error: unknown) {
  const value = error as {
    response?: { status?: number; data?: { error?: { errors?: { reason?: string }[] } } };
    code?: string; message?: string;
  };
  const status = value?.response?.status ?? null;
  const reasons = value?.response?.data?.error?.errors?.map((item) => item.reason)
    .filter((reason): reason is string => typeof reason === 'string' && /^[\w.-]+$/.test(reason)) ?? [];
  const category = value?.code === 'API_KEY_REQUIRED' ? 'authentication' : status === 401 || status === 403 && reasons.some((reason) =>
    ['keyInvalid', 'accessNotConfigured', 'ipRefererBlocked', 'forbidden'].includes(reason))
    ? 'authentication' : status ? 'youtube_api' : value?.code === 'CHANNEL_NOT_FOUND' ? 'not_found' : 'transport';
  const message = value?.code === 'API_KEY_REQUIRED' ? 'This tool requires a YouTube API key (YOUTUBE_API_KEY).'
    : value?.code === 'CHANNEL_NOT_FOUND' ? 'Channel not found or uploads playlist unavailable.'
    : status ? `YouTube API HTTP ${status}${reasons.length ? `: ${reasons.join(', ')}` : ''}.`
    : 'YouTube API request failed. Check API key configuration and network connectivity.';
  return { isError: true, content: [{ type: 'text' as const,
    text: JSON.stringify({ error: { category, message, httpStatus: status, reasons,
      retryable: status === 429 || status !== null && status >= 500 } }) }] };
}
