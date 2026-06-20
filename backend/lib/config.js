import fs from 'fs';
import path from 'path';

export function getBinaryPath(binaryName) {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const localPath = path.resolve(process.cwd(), 'bin', `${binaryName}${ext}`);
  return fs.existsSync(localPath) ? localPath : binaryName;
}

export const YTDLP_BIN = getBinaryPath('yt-dlp');
export const FFMPEG_BIN = getBinaryPath('ffmpeg');

export const CONFIG = {
  PORT: process.env.XDOWN_PORT || 8000,

  HLS: {
    SEGMENT_DURATION: 2,
    MAX_SESSIONS: 10,
    SESSION_TTL: 30 * 60 * 1000,
    CLEANUP_INTERVAL: 60 * 1000,
    READY_SEGMENTS: 3,
    READY_TIMEOUT: 35000,
  },

  CACHE: {
    INFO_MAX_ENTRIES: 50,
    INFO_TTL: 30 * 60 * 1000,
    COOKIE_TTL: 5 * 60 * 1000,
  },

  PUPPETEER: {
    MAX_CRASH_RESTARTS: 3,
    CRASH_WINDOW: 60 * 1000,
    NAV_TIMEOUT: 15000,
    WAIT_TIMEOUT: 12000,
  },

  DOWNLOAD: {
    STALL_TIMEOUT: 30000,
  },

  // Single source of truth — client fetches this from /config
  COOKIE_DOMAINS: [
    'pornhub.com', 'xhamster.com', 'xnxx.com', 'xvideos.com',
    'youporn.com', 'redtube.com', 'spankbang.com', 'tube8.com',
    'thisvid.com', 'empflix.com', 'nuvid.com', 'txxx.com',
    'drtuber.com', 'hardsextube.com', 'porntrex.com', 'hclips.com',
    'fapster.xxx', 'porn.com', 'beeg.com', 'tubegalore.com',
    'xfantasy.com', 'fuq.com', 'hdzog.com', 'iceporn.com',
    'pornoxo.com', 'fux.com', 'vjav.com', 'javmost.com',
  ],

  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  AD_DOMAINS: [
    'trafficjunky.net', 'trafficfactory.biz', 'tsyndicate.com',
    'exoclick.com', 'adnium.com', 'plugrush.com', 'juicyads.com',
    'a-ads.com', 'adtng.com', 'mngads.com', 'popads.net',
    'adnetwork.net', 'tubeads.com', 'xbidder.com',
    'adspyglass.com', 'doubleverify.com', 'adsafeprotected.com',
    'moatads.com', 'pornvertiser.com', 'sexad.net', 'porniframe.com',
    'redmoon-media.com', 'trafficstars.com', 'ero-advertising.com',
  ],
};
