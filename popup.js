(() => {
  const byId = id => document.getElementById(id);
  const selection = byId('selection');
  const transfer = byId('transfer');
  const grid = byId('items');
  const selectAll = byId('select-all');
  const download = byId('download');
  const status = byId('status');
  const refresh = byId('refresh');
  const back = byId('back');
  const tabs = { foto: byId('photos'), video: byId('videos') };

  let listing;
  let category = 'foto';
  let selected = new Set();

  function visibleItems() {
    return listing?.items.filter(item => item.kind === category) || [];
  }

  function updateSelection() {
    const items = visibleItems().filter(item => !item.stream);
    const count = items.filter(item => selected.has(item)).length;
    selectAll.checked = items.length > 0 && count === items.length;
    selectAll.indeterminate = count > 0 && count < items.length;
    byId('count').textContent = `${count} de ${items.length}`;
    download.disabled = count === 0;
    download.textContent = count ? `Baixar ${count} ${count === 1 ? category : category + 's'}` : 'Baixar seleção';
  }

  function renderCard(item) {
    const card = byId('media-card').content.firstElementChild.cloneNode(true);
    const thumbnail = card.querySelector('.thumbnail');
    const checkbox = card.querySelector('.pick');
    const button = card.querySelector('button');
    thumbnail.textContent = item.kind === 'video' ? '▶' : 'Foto';
    if (item.preview) {
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => {
        thumbnail.textContent = item.kind === 'video' ? '▶' : 'Imagem';
      }, { once: true });
      thumbnail.replaceChildren(image);
      image.src = item.preview;
    }
    checkbox.hidden = Boolean(item.stream);
    checkbox.checked = selected.has(item);
    checkbox.setAttribute('aria-label', 'Selecionar ' + item.label);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(item);
      else selected.delete(item);
      updateSelection();
    });
    button.setAttribute('aria-label', 'Baixar ' + item.label);
    if (item.kind === 'video') {
      button.className = 'video-download';
      button.textContent = 'Baixar vídeo';
    }
    button.addEventListener('click', () => item.stream ? downloadClip(item) : downloadItems([item]));
    return card;
  }

  function renderGallery() {
    for (const [kind, tab] of Object.entries(tabs)) {
      const count = listing?.items.filter(item => item.kind === kind).length || 0;
      tab.textContent = `${kind === 'foto' ? 'Fotos' : 'Vídeos'} · ${count}`;
      tab.setAttribute('aria-pressed', String(kind === category));
    }
    const items = visibleItems();
    grid.replaceChildren(...items.map(renderCard));
    if (listing?.items.length) {
      status.textContent = category === 'video' && items.length ? 'Vídeo encontrado' : '';
    }
    byId('toolbar').hidden = !items.some(item => !item.stream);
    byId('video-options').hidden = !listing || category !== 'video' || items.length > 0;
    download.hidden = !items.some(item => !item.stream);
    updateSelection();
  }

  async function scan() {
    refresh.disabled = true;
    listing = null;
    selected.clear();
    byId('listing').hidden = true;
    status.textContent = 'Procurando mídias…';
    renderGallery();

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tab?.url && new URL(tab.url);
      const hosts = ['www.mercadolivre.com.br', 'mercadolivre.com.br', 'produto.mercadolivre.com.br'];
      if (url?.protocol !== 'https:' || !hosts.includes(url.hostname)) {
        status.textContent = 'Abra um anúncio do Mercado Livre Brasil.';
        return;
      }

      const [scan] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scanListing,
        args: [tab.url]
      });
      listing = scan?.result;
      if (!listing) {
        status.textContent = 'Abra a página individual de um anúncio.';
        return;
      }

      listing.items.push(...listing.playlists.map(url => ({ kind: 'video', stream: true, url })));
      const numbers = { foto: 0, video: 0 };
      for (const item of listing.items) {
        item.number = ++numbers[item.kind];
        item.label = `${item.kind === 'foto' ? 'Foto' : 'Vídeo'} ${item.number}`;
      }
      selected = new Set(listing.items.filter(item => !item.stream));
      byId('listing').hidden = false;
      byId('title').textContent = listing.title || 'Anúncio do Mercado Livre';
      byId('code').textContent = listing.id;
      const cover = byId('cover');
      const preview = listing.items.find(item => item.kind === 'foto')?.preview;
      cover.hidden = !preview;
      if (preview) cover.src = preview;
      status.textContent = listing.items.length ? '' : 'Nenhuma mídia encontrada.';
      category = numbers.foto || !numbers.video ? 'foto' : 'video';
    } catch {
      status.textContent = 'Não foi possível ler o anúncio. Atualize a lista.';
    } finally {
      refresh.disabled = false;
      renderGallery();
    }
  }

  function saveFile(url, name) {
    return chrome.downloads.download({
      url,
      filename: `${listing.id}/${name}`,
      conflictAction: 'uniquify',
      saveAs: false
    }).then(id => new Promise((resolve, reject) => {
      function finish(state) {
        if (!state || state === 'in_progress') return;
        chrome.downloads.onChanged.removeListener(onChange);
        if (state === 'complete') resolve();
        else reject(new Error('Download interrompido.'));
      }

      function onChange(delta) {
        if (delta.id === id) finish(delta.state?.current);
      }

      chrome.downloads.onChanged.addListener(onChange);
      chrome.downloads.search({ id }).then(([item]) => finish(item?.state || 'interrupted'),
        () => finish('interrupted'));
    }));
  }

  function openTransfer(labels) {
    selection.hidden = true;
    transfer.hidden = false;
    back.disabled = true;
    byId('transfer-title').textContent = '↓ Baixando mídia';
    byId('destination').textContent = `Pasta Downloads / ${listing.id}`;
    byId('transfer-status').textContent = 'Mantenha este painel aberto.';
    const rows = labels.map(label => {
      const row = document.createElement('li');
      const name = document.createElement('strong');
      const state = document.createElement('span');
      name.textContent = label;
      state.textContent = 'Na fila';
      row.append(name, state);
      return row;
    });
    byId('queue').replaceChildren(...rows);
    showProgress(0, labels.length);
    return rows.map(row => row.lastElementChild);
  }

  function showProgress(done, total, fraction = done / total) {
    const percent = Math.round(fraction * 100);
    byId('progress').value = percent;
    byId('percent').textContent = percent + '%';
    byId('transfer-count').textContent = `${done} de ${total}`;
  }

  function finishTransfer(message) {
    byId('transfer-title').textContent = '↓ Resultado do download';
    byId('transfer-status').textContent = message;
    back.disabled = false;
    back.focus();
  }

  async function downloadItems(items) {
    const rows = openTransfer(items.map(item => item.label));
    let saved = 0;
    for (const [index, item] of items.entries()) {
      const name = `${item.kind}-${String(item.number).padStart(2, '0')}.${item.ext}`;
      rows[index].textContent = 'Baixando';
      try {
        try {
          await saveFile(item.url, name);
          rows[index].textContent = 'Concluído';
        } catch (error) {
          if (!item.fallback || item.fallback === item.url) throw error;
          await saveFile(item.fallback, name);
          rows[index].textContent = 'Versão da galeria';
        }
        saved++;
      } catch {
        rows[index].textContent = 'Falhou';
      }
      showProgress(index + 1, items.length);
    }
    finishTransfer(`${saved} de ${items.length} arquivos salvos.`);
  }

  async function downloadClip(item) {
    const [row] = openTransfer([item.label]);
    let fileUrl;
    try {
      if (!await chrome.permissions.request({ origins: [hlsOrigin + '/*'] })) {
        throw new Error('Acesso ao servidor de Clips não concedido.');
      }
      const clip = await buildClip(item.url, (part, total) => {
        row.textContent = 'Baixando';
        showProgress(0, 1, (part - 1) / total);
      });
      row.textContent = 'Salvando';
      fileUrl = URL.createObjectURL(clip);
      await saveFile(fileUrl, 'clip.ts');
      row.textContent = 'Concluído';
      showProgress(1, 1);
      finishTransfer('Vídeo salvo.');
    } catch {
      row.textContent = 'Falhou';
      finishTransfer('Não foi possível salvar o vídeo. Abra-o no anúncio e atualize a lista.');
    } finally {
      if (fileUrl) URL.revokeObjectURL(fileUrl);
    }
  }

  for (const [kind, tab] of Object.entries(tabs)) {
    tab.addEventListener('click', () => {
      category = kind;
      renderGallery();
    });
  }
  selectAll.addEventListener('change', () => {
    for (const item of visibleItems()) {
      if (item.stream) continue;
      if (selectAll.checked) selected.add(item);
      else selected.delete(item);
    }
    renderGallery();
    selectAll.focus();
  });
  download.addEventListener('click', () => downloadItems(visibleItems().filter(item => selected.has(item))));
  refresh.addEventListener('click', scan);
  back.addEventListener('click', () => {
    transfer.hidden = true;
    selection.hidden = false;
    tabs[category].focus();
  });
  scan();
})();
