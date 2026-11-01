import { YouTubeService } from '../../dist/youtube-service.js';

YouTubeService.prototype.getChannelUploads = async function (
  channelId,
  _limit,
  _pageToken,
  signal,
) {
  console.log(JSON.stringify({ event: 'provider_started' }));
  if (process.env.TEST_STALLED_PROVIDER === '1') {
    signal?.addEventListener(
      'abort',
      () => console.log(JSON.stringify({ event: 'provider_aborted' })),
      { once: true },
    );
    // Deliberately uncooperative: shutdown must also handle providers that ignore abort.
    await new Promise(() => {});
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  return {
    channelId,
    uploadsPlaylistId: 'uploads',
    order: 'uploads-playlist',
    items: [],
    nextPageToken: null,
  };
};
