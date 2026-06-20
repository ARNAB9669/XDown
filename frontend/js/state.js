export let videoInfo = null;
export let hlsInstance = null;
export let shakaPlayer = null;
export let serverConfig = { cookieDomains: [], adDomains: [] };

export function setVideoInfo(v)     { videoInfo = v; }
export function setHlsInstance(v)   { hlsInstance = v; }
export function setShakaPlayer(v)   { shakaPlayer = v; }
export function setServerConfig(v)  { serverConfig = v; }
