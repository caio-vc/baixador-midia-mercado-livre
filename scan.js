function scanListing(expectedUrl) {
  const url = new URL(location.href);
  const expected = new URL(expectedUrl);
  const listing = /^(?:www\.)?mercadolivre\.com\.br$/.test(url.hostname)
    ? url.pathname.match(/^\/(?:[^/]+\/)?(?:p\/(MLB\d+)|up\/(MLBU\d+))\/?$/i)
    : url.hostname === 'produto.mercadolivre.com.br'
      ? url.pathname.match(/^\/(MLB-\d+)(?:-|\/|$)/i)
      : null;
  if (!listing || url.protocol !== 'https:' ||
      url.origin !== expected.origin || url.pathname !== expected.pathname) return null;

  const gallerySelector = '.ui-pdp-gallery, [data-testid="gallery"], [data-testid="image-gallery"], ' +
    '[aria-label^="Galeria de fotos" i]';
  const photoButtonSelector = '[aria-label^="Imagem " i]';
  const mediaSelector = gallerySelector +
    ', .ui-pdp-gallery__wrapper, .ui-pdp-gallery__thumbnail, .ui-pdp-gallery__figure';
  const clipSelector = '.ui-pdp-gallery__thumbnail--video, .ui-pdp-gallery__thumbnail--clip, ' +
    '.ui-pdp-gallery__figure--video, .ui-pdp-gallery__figure--clip, ' +
    '[data-testid="video-thumbnail"], [data-testid="clip-thumbnail"]';
  const photoPattern = /^\/(?:D_(?:NQ|Q)_NP(?:_\d+X)?_)?(\d+-ML[A-Z]\d+_\d+)-([A-Z])(?:-[^/]+)?\.(jpg|jpeg|png|webp|avif)$/i;
  const photos = new Map();
  const numberedPhotos = new Set();
  const videos = new Map();
  const playlists = new Map();

  function recordPlaylist(asset) {
    if (asset?.origin !== 'https://video-vod-clips.mms.mlstatic.com') return;
    const match = asset.pathname.match(/^\/v1\/video\/hls\/([^/]+\/[^/]+)\/index-f(\d+)-v\d+-a\d+\.m3u8$/i);
    if (!match) return;
    const [, clipId, rendition] = match;
    const rank = Number(rendition);
    if (!playlists.has(clipId) || playlists.get(clipId).rank < rank) {
      playlists.set(clipId, { url: asset.href, rank });
    }
  }

  function cdn(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const asset = new URL(value, url);
      if (asset.protocol !== 'https:' || asset.username || asset.password || asset.port ||
          !asset.hostname.endsWith('.mlstatic.com')) return null;
      asset.hash = '';
      return asset;
    } catch {
      return null;
    }
  }

  function addPhoto(value, numbered = false) {
    const asset = cdn(value);
    const match = asset?.pathname.match(photoPattern);
    if (!match) return;
    const [, id, size, ext] = match;
    if (numbered) numberedPhotos.add(id);
    const rank = size.toUpperCase() === 'F' && /_2X_/i.test(asset.pathname)
      ? 6 : ({ F: 5, O: 4, V: 3, C: 2, I: 1 })[size.toUpperCase()] || 0;
    const previous = photos.get(id);
    if (previous && previous.rank >= rank) return;
    const original = new URL(asset);
    if (!original.search && size.toUpperCase() !== 'F') {
      original.pathname = '/D_NQ_NP_' + id + '-F.' + ext;
    }
    photos.set(id, { kind: 'foto', url: original.href, preview: asset.href,
      fallback: asset.href, ext: ext.toLowerCase(), rank });
  }

  function addVideo(value, mime, poster) {
    const asset = cdn(value);
    if (!asset) return;
    const type = (mime || '').split(';')[0].trim().toLowerCase();
    if (/\.m3u8$/i.test(asset.pathname) || /^(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)$/.test(type)) {
      recordPlaylist(asset);
      return;
    }
    if (/\.mpd$/i.test(asset.pathname) || type === 'application/dash+xml') return;
    if (!/\.mp4$/i.test(asset.pathname) && type !== 'video/mp4') return;
    if (/\/preview[_-]/i.test(asset.pathname)) return;
    videos.set(asset.href, { kind: 'video', url: asset.href, ext: 'mp4',
      preview: cdn(poster)?.href || videos.get(asset.href)?.preview });
  }

  for (const gallery of document.querySelectorAll(mediaSelector + ', ' + photoButtonSelector)) {
    for (const img of gallery.querySelectorAll('img, picture source')) {
      const button = img.closest(photoButtonSelector);
      const numbered = /^Imagem \d+ de \d+ de /i.test(button?.getAttribute('aria-label') || '');
      if (gallery.matches?.(photoButtonSelector) && !numbered) continue;
      // Um contêiner de galeria com Clip também contém as fotos do produto.
      const clip = img.closest(clipSelector);
      if (clip && !numbered) continue;
      for (const name of ['srcset', 'data-srcset']) {
        for (const candidate of (img.getAttribute(name) || '').split(',')) {
          addPhoto(candidate.trim().split(/\s+/)[0], numbered);
        }
      }
      for (const name of ['data-zoom', 'data-src', 'data-lazy-src', 'src']) {
        addPhoto(img.getAttribute(name), numbered);
      }
      addPhoto(img.currentSrc, numbered);
    }
  }

  const posterIds = new Set();
  // A página pode abrir o player do Clip num modal fora da galeria.
  for (const video of document.querySelectorAll('video')) {
    if (!video.closest(mediaSelector + ', [role="dialog"], .ui-pdp-modal, [class*="clips-player"], [class*="clip-player"]')) continue;
    const posterId = cdn(video.poster)?.pathname.match(photoPattern)?.[1];
    if (posterId) posterIds.add(posterId);
    if (video.mediaKeys || video.querySelector('source[src$=".mpd"]')) {
      continue;
    }
    for (const source of video.querySelectorAll('source')) {
      addVideo(source.getAttribute('src'), source.type, video.poster);
    }
    for (const value of [video.currentSrc, video.getAttribute('src')]) {
      addVideo(value, '', video.poster);
    }
  }
  // O player pode buscar a playlist via XHR e expor apenas blob no DOM.
  for (const { name } of performance.getEntriesByType('resource')) {
    if (!/\.m3u8(?:[?#]|$)/i.test(name)) continue;
    recordPlaylist(cdn(name));
  }

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse(script.textContent);
    } catch {
      continue;
    }
    for (const root of [data].flat()) {
      for (const product of [root, ...(Array.isArray(root?.['@graph']) ? root['@graph'] : [])]) {
        if (![product?.['@type']].flat().includes('Product')) continue;
        for (const image of [product.image].flat()) {
          addPhoto(typeof image === 'string' ? image : image?.contentUrl || image?.url);
        }
      }
    }
  }

  for (const id of posterIds) {
    if (!numberedPhotos.has(id)) photos.delete(id);
  }
  const items = [...photos.values(), ...videos.values()].map(({ rank, ...item }) => item);
  return {
    id: (listing[1] || listing[2]).replace('-', '').toUpperCase(),
    title: document.querySelector('h1')?.textContent.trim(),
    items,
    playlists: [...playlists.values()].map(({ url }) => url)
  };
}
