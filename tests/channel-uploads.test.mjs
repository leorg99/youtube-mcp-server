import assert from 'node:assert/strict';
import test from 'node:test';
import { YouTubeService } from '../dist/youtube-service.js';
import { dataApiError } from '../dist/api-errors.js';

const channels = ['UCjZnbgPb08NFg7MHyPQRZ3Q', 'UCvWx0-NX-9qVLCSW9yjdX-g',
  'UCrGLm-Drgv0vbbemwwHeXJw', 'UCnlyaLgmqTcmXLRLLfH1Rsg', 'UC_CiWMWvLpnQAze7eITbE0w',
  'UC845dNHqx3JIeHRl3Zl_j_A', 'UCp4CBeq4nzeg9smAvdjPrig', 'UC_2Y_cJ8s02JYyeF3vg_5lg'];
for (const id of channels) {
  test(`uploads resolve ${id} and forward pagination without search`, async () => {
    const service = new YouTubeService('test-key');
    const calls = [];
    service.youtube = {
      search: { list() { assert.fail('search.list must never be called'); } },
      channels: { list: async (params) => {
        assert.deepEqual(params, { part: ['contentDetails'], id: [id] });
        // Deliberately not derived from UC -> UU: must use returned playlist ID.
        return { data: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'actual-uploads' } } }] } };
      } },
      playlistItems: { list: async (params) => {
        calls.push(params);
        return { data: { nextPageToken: params.pageToken ? undefined : 'page-2', items: [{
          id: 'item-1', snippet: { title: 'Latest', description: 'Details', channelId: id,
            channelTitle: 'Channel', thumbnails: { high: { url: 'https://example.com/thumb.jpg' } },
            publishedAt: '2026-11-01T00:00:00Z' },
          contentDetails: { videoId: 'video-1', videoPublishedAt: '2026-10-31T00:00:00Z' },
        }] } };
      } },
    };
    const first = await service.getChannelUploads(id, 2);
    const second = await service.getChannelUploads(id, 2, first.nextPageToken);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { part: ['snippet', 'contentDetails'], playlistId: 'actual-uploads', maxResults: 2, pageToken: undefined });
    assert.equal(calls[1].pageToken, 'page-2');
    assert.equal(second.nextPageToken, null);
    assert.deepEqual(first.items[0], { playlistItemId: 'item-1', videoId: 'video-1', title: 'Latest',
      description: 'Details', channelId: id, channelTitle: 'Channel',
      publishedAt: '2026-10-31T00:00:00Z', playlistAddedAt: '2026-11-01T00:00:00Z',
      thumbnails: { high: { url: 'https://example.com/thumb.jpg' } }, videoUrl: 'https://www.youtube.com/watch?v=video-1' });
  });
}
test('unavailable channel and invalid bounds fail without playlist/search calls', async () => {
  const service = new YouTubeService('test-key');
  service.youtube = { channels: { list: async () => ({ data: { items: [] } }) } };
  await assert.rejects(service.getChannelUploads(channels[0]), { code: 'CHANNEL_NOT_FOUND' });
  for (const bound of [0, 51, 1.5]) await assert.rejects(service.getChannelUploads(channels[0], bound), /integer/);
});
test('API errors preserve status and reason while redacting request secrets', () => {
  const error = { response: { status: 403, data: { error: { errors: [{ reason: 'quotaExceeded' }] } } },
    message: 'secret-key', config: { url: 'https://example.com?key=secret-key' } };
  const result = dataApiError(error);
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text).error;
  assert.equal(payload.category, 'youtube_api');
  assert.equal(payload.httpStatus, 403);
  assert.deepEqual(payload.reasons, ['quotaExceeded']);
  assert.ok(!JSON.stringify(result).includes('secret-key'));
  assert.equal(JSON.parse(dataApiError({ response: { status: 401 } }).content[0].text).error.category, 'authentication');
});
test('Google HTTP 400 API_KEY_INVALID is authentication, not a transient argument error', () => {
  const result = dataApiError({ response: { status: 400, data: { error: {
    status: 'INVALID_ARGUMENT', errors: [{ reason: 'badRequest' }],
    details: [{ reason: 'API_KEY_INVALID', metadata: { key: 'secret-key' } }],
  } } } });
  const error = JSON.parse(result.content[0].text).error;
  assert.equal(error.category, 'authentication');
  assert.equal(error.code, 'INVALID_ARGUMENT');
  assert.ok(error.message.includes('API_KEY_INVALID'));
  assert.equal(error.retryable, false);
  assert.ok(!JSON.stringify(result).includes('secret-key'));
});
test('malformed API arguments and missing resources retain distinct categories', () => {
  for (const [status, category] of [[400, 'invalid_arguments'], [404, 'not_found']]) {
    const error = JSON.parse(dataApiError({ response: { status } }).content[0].text).error;
    assert.equal(error.category, category);
    assert.equal(error.httpStatus, status);
    assert.equal(error.retryable, false);
  }
});
