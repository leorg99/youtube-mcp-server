import { YouTubeService } from '../../dist/youtube-service.js';
YouTubeService.prototype.getChannelUploads = async function () {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { items: [], nextPageToken: null };
};
