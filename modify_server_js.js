const fs = require('fs');
const lines = fs.readFileSync('backend/server.js', 'utf8').split('\n');

const imports = `import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';

import { CONFIG, YTDLP_BIN, FFMPEG_BIN } from './lib/config.js';
import { infoCache } from './lib/lruCache.js';
import { cookieManager } from './lib/cookieManager.js';
import { hlsManager } from './lib/hlsSessionManager.js';
import { ytDlpInfo, ytDlpDownload } from './lib/ytdlp.js';
import { extractWithPuppeteer } from './lib/puppeteerExtractor.js';
import { pipeStream, resolveBestQualityUrl } from './lib/streamPipe.js';
import { safeFilename } from './lib/helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
`;

const expressAppStart = lines.findIndex(l => l.includes('// ─── Express app'));
const pipeStreamStart = lines.findIndex(l => l.includes('// ─── pipeStream'));
const m3u8ProxyStart = lines.findIndex(l => l.includes('// ─── /m3u8-proxy'));

const part1 = lines.slice(expressAppStart, pipeStreamStart).join('\n');
const part2 = lines.slice(m3u8ProxyStart).join('\n');

fs.writeFileSync('backend/server.js', imports + '\n' + part1 + '\n' + part2);
console.log('Modified server.js');
