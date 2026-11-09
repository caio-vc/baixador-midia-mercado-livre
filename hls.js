const hlsOrigin = 'https://video-vod-clips.mms.mlstatic.com';

function parseClipPlaylist(text, url) {
  const lines = text.trim().split(/\r?\n/).map(line => line.trim());
  if (lines[0] !== '#EXTM3U' || !lines.includes('#EXT-X-ENDLIST') ||
      lines.some(line => /^#EXT-X-(?:KEY|SESSION-KEY|MAP|BYTERANGE|DISCONTINUITY|GAP|STREAM-INF|MEDIA:)/.test(line))) {
    throw new Error('Formato HLS incompatível ou protegido.');
  }
  const segments = lines.filter(line => line && !line.startsWith('#')).map(line => new URL(line, url));
  const durations = lines.filter(line => line.startsWith('#EXTINF:'));
  if (!segments.length || segments.length !== durations.length || segments.length > 150 ||
      segments.some(segment => segment.origin !== hlsOrigin || segment.username || segment.password ||
        !segment.pathname.startsWith('/v1/video/hls/') || !segment.pathname.endsWith('.ts'))) {
    throw new Error('Lista de segmentos incompatível.');
  }
  return segments.map(segment => segment.href);
}

async function fetchClipPart(url) {
  const response = await fetch(url, { credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error('O servidor recusou um arquivo do Clip.');
  return response;
}

async function buildClip(url, progress) {
  const segments = parseClipPlaylist(await (await fetchClipPart(url)).text(), url);
  const chunks = [];
  let bytes = 0;
  for (const [index, segment] of segments.entries()) {
    progress(index + 1, segments.length);
    const chunk = await (await fetchClipPart(segment)).arrayBuffer();
    const data = new Uint8Array(chunk);
    if (!data.length || data.length % 188 || data[0] !== 0x47) {
      throw new Error('O segmento recebido não é MPEG-TS compatível.');
    }
    bytes += data.length;
    if (bytes > 150 * 1024 * 1024) throw new Error('O Clip excede o limite de 150 MB.');
    chunks.push(chunk);
  }
  return new Blob(chunks, { type: 'video/mp2t' });
}
