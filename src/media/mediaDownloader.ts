/**
 * 媒体下载器 - 从钉钉下载语音、图片等媒体文件
 */
import axios from 'axios';
import { DingtalkService } from '../dingtalk/dingtalk';

export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  size: number;
}

const MIME_MAP: Record<string, string> = {
  amr: 'audio/amr',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
};

export class MediaDownloader {
  private dingtalkService: DingtalkService;
  private accessToken: string = '';
  private tokenExpiresAt: number = 0;

  constructor(dingtalkService: DingtalkService) {
    this.dingtalkService = dingtalkService;
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const token = await this.dingtalkService.getAccessToken();
    this.accessToken = token;
    this.tokenExpiresAt = Date.now() + 7000 * 1000; // 钉钉 token 有效期 7200 秒
    return token;
  }

  async downloadMedia(mediaId: string, format?: string): Promise<DownloadedMedia> {
    const token = await this.getAccessToken();
    const url = `https://oapi.dingtalk.com/media/downloadFile?mediaId=${encodeURIComponent(mediaId)}&access_token=${token}`;

    console.log(`[Media] Downloading media: ${mediaId.substring(0, 20)}...`);

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    const buffer = Buffer.from(response.data);
    const ext = format || this.guessExtension(response.headers['content-type'] || '');
    const mimeType = MIME_MAP[ext] || response.headers['content-type'] || 'application/octet-stream';

    console.log(`[Media] Downloaded: ${buffer.length} bytes, type: ${mimeType}`);

    return {
      buffer,
      mimeType,
      fileName: `media_${mediaId.substring(0, 8)}.${ext}`,
      size: buffer.length,
    };
  }

  private guessExtension(contentType: string): string {
    const ct = contentType.toLowerCase();
    if (ct.includes('amr')) return 'amr';
    if (ct.includes('wav')) return 'wav';
    if (ct.includes('mp3') || ct.includes('mpeg')) return 'mp3';
    if (ct.includes('png')) return 'png';
    if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
    if (ct.includes('gif')) return 'gif';
    if (ct.includes('mp4')) return 'mp4';
    if (ct.includes('pdf')) return 'pdf';
    return 'bin';
  }
}