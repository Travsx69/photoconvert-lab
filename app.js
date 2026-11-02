(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const MAX_EDGE = 5000;
  const MAX_PARALLEL = 2;
  const state = {
    items: [],
    quality: 92,
    active: 0,
    seq: 0,
    runToken: 0,
    demoLoading: false,
    zipping: false,
  };

  const refs = {
    body: document.body,
    fileInput: $('#fileInput'),
    heroChoose: $('#heroChoose'),
    trayChoose: $('#trayChoose'),
    demoBtn: $('#demoBtn'),
    addBtn: $('#addBtn'),
    grid: $('#grid'),
    lab: $('#lab'),
    labTitle: $('#labTitle'),
    frameCount: $('#frameCount'),
    statusText: $('#statusText'),
    downloadAll: $('#downloadAll'),
    downloadLabel: $('#downloadLabel'),
    downloadSize: $('#downloadSize'),
    qualityBtn: $('#qualityBtn'),
    qualityPanel: $('#qualityPanel'),
    qualityValue: $('#qualityValue'),
    qualityBig: $('#qualityBig'),
    qualityRange: $('#qualityRange'),
    resetBtn: $('#resetBtn'),
    dragOverlay: $('#dragOverlay'),
    toast: $('#toast'),
  };

  const isHeic = (file) => /\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type || '');
  const isSupported = (file) => {
    const name = file.name.toLowerCase();
    return /\.(heic|heif|jpe?g|jfif|png|webp|avif)$/.test(name) ||
      /^image\/(jpeg|png|webp|avif|heic|heif)$/i.test(file.type || '');
  };

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function baseName(name) {
    return name.replace(/\.[^.]+$/, '');
  }

  function inputFormat(file) {
    const ext = (file.name.split('.').pop() || '').toUpperCase();
    if (ext === 'JPG' || ext === 'JPEG' || ext === 'JFIF') return 'JPG';
    if (ext === 'HEIF') return 'HEIF';
    if (ext === 'HEIC') return 'HEIC';
    return ext || 'IMG';
  }

  function outputName(file) {
    return `${baseName(file.name)}.jpg`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function toast(message, duration = 3200) {
    refs.toast.textContent = message;
    refs.toast.classList.add('is-visible');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => refs.toast.classList.remove('is-visible'), duration);
  }

  function itemById(id) {
    return state.items.find((item) => item.id === id);
  }

  function itemIndex(item) {
    return state.items.indexOf(item);
  }

  function updateCounts() {
    const total = state.items.length;
    const ready = state.items.filter((item) => item.status === 'ready').length;
    const failed = state.items.filter((item) => item.status === 'error').length;
    const active = state.items.filter((item) => item.status === 'queued' || item.status === 'working').length;

    refs.frameCount.textContent = total
      ? (ready === total && !failed ? `${ready} ready` : `${ready} / ${total} ready`)
      : '0 frames';

    if (!total) {
      refs.statusText.textContent = 'Waiting for photos…';
    } else if (active) {
      refs.statusText.innerHTML = `Developing <strong>${ready + failed}</strong> of <strong>${total}</strong>…`;
    } else if (failed) {
      refs.statusText.innerHTML = `<strong>${ready}</strong> JPG${ready === 1 ? '' : 's'} ready · ${failed} could not be developed`;
    } else {
      const bytes = state.items.reduce((sum, item) => sum + (item.outBytes || 0), 0);
      refs.statusText.innerHTML = `<strong>${ready}</strong> JPG${ready === 1 ? '' : 's'} ready · ${formatBytes(bytes)} total`;
    }

    updateDownload();
  }

  function updateDownload() {
    const ready = state.items.filter((item) => item.status === 'ready');
    const totalBytes = ready.reduce((sum, item) => sum + item.outBytes, 0);
    const busy = state.items.some((item) => item.status === 'queued' || item.status === 'working');
    refs.qualityBtn.disabled = busy;

    if (!ready.length) {
      refs.downloadLabel.textContent = 'Download JPGs';
      refs.downloadSize.textContent = '';
      refs.downloadAll.disabled = true;
      return;
    }

    if (ready.length === 1) {
      refs.downloadLabel.textContent = 'Download JPG';
    } else {
      refs.downloadLabel.textContent = `Download ${ready.length} JPGs`;
    }
    refs.downloadSize.textContent = formatBytes(totalBytes);
    refs.downloadAll.disabled = busy || state.zipping;
  }

  function cardMarkup(item, index) {
    const isReady = item.status === 'ready';
    const isError = item.status === 'error';
    const isWorking = item.status === 'working';
    const isQueued = item.status === 'queued';
    const dims = isReady ? `${item.width} × ${item.height}` : '';
    const fromLabel = isReady
      ? `${formatBytes(item.inBytes)} ${item.inputFormat}`
      : isError
        ? 'Original kept on device'
        : isWorking
          ? 'Decoding locally…'
          : 'Waiting for a turn';
    const delta = isReady ? sizeDelta(item.inBytes, item.outBytes) : null;
    const freshClass = item.fresh ? ' fresh' : '';
    const style = ` style="--i:${Math.min(index, 9)}"`;
    const errorText = isError
      ? `<div class="print-error"><b>This one did not develop.</b><span>${escapeHtml(item.error || 'The file could not be read.')}</span><button type="button" data-remove="${item.id}">Remove frame</button></div>`
      : '';
    const working = isWorking || isQueued
      ? `<div class="developing"><span class="dev-label"><span>${isWorking ? (item.stage || 'Developing') : 'Queued'}</span><span>${isWorking ? 'LOCAL' : '—'}</span></span></div>`
      : '';
    const image = isReady
      ? `<img src="${item.url}" alt="${escapeHtml(item.outName)} converted preview" width="${item.width}" height="${item.height}" loading="lazy" decoding="async">`
      : '';

    return `<article class="print${freshClass}${isError ? ' is-error' : ''}" data-id="${item.id}"${style}>
      <div class="print-head">
        <span class="print-index">${String(index + 1).padStart(2, '0')}</span>
        <span class="print-badge${isError ? ' is-error' : ''}">${isError ? 'ERR' : 'JPG'}</span>
      </div>
      <div class="print-image">
        ${image}${working}${errorText}
        ${isReady ? `<button class="print-dl" type="button" data-download="${item.id}" aria-label="Download ${escapeHtml(item.outName)}" title="Download ${escapeHtml(item.outName)}">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v10m0 0 4-4m-4 4-4-4M3 16h14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>` : ''}
      </div>
      <div class="print-meta">
        <div style="min-width:0">
          <p class="print-name" title="${escapeHtml(isReady ? item.outName : item.file.name)}">${escapeHtml(isReady ? item.outName : item.file.name)}</p>
          <span class="print-dims">${isReady ? `${dims}${item.scaled ? ' · resized' : ''}` : '—'}</span>
        </div>
        <span class="print-size">${isReady ? formatBytes(item.outBytes) : '—'}</span>
      </div>
      <div class="print-sub">
        <span>${fromLabel}</span>
        ${isReady && delta ? `<span class="print-delta ${delta.className}">${delta.label}</span>` : ''}
      </div>
    </article>`;
  }

  function sizeDelta(before, after) {
    if (!before || !after) return { label: '', className: 'is-neutral' };
    const pct = Math.round(((after - before) / before) * 100);
    if (Math.abs(pct) < 1) return { label: 'same size', className: 'is-neutral' };
    if (pct > 0) return { label: `+${pct}% vs ${'original'}`, className: 'is-larger' };
    return { label: `${pct}% smaller`, className: '' };
  }

  function renderGrid() {
    refs.grid.innerHTML = state.items.map((item, index) => cardMarkup(item, index)).join('');
    state.items.forEach((item) => { item.fresh = false; });
  }

  function refreshCard(item) {
    const current = refs.grid.querySelector(`[data-id="${item.id}"]`);
    if (!current) return;
    const index = itemIndex(item);
    item.fresh = false;
    current.outerHTML = cardMarkup(item, index);
  }

  function openLab(scroll = true) {
    const wasOpen = refs.body.classList.contains('lab-open');
    refs.body.classList.add('lab-open');
    refs.lab.hidden = false;
    if (scroll && !wasOpen) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function closeLab() {
    refs.body.classList.remove('lab-open');
    refs.lab.hidden = true;
    closeQuality();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function addFiles(fileList) {
    const incoming = Array.from(fileList || []);
    const supported = incoming.filter(isSupported);
    const skipped = incoming.length - supported.length;

    if (!supported.length) {
      toast(incoming.length ? 'Those files are not JPG, PNG, WebP, AVIF, HEIC or HEIF images.' : 'Choose some photos first.');
      return;
    }

    const wasOpen = refs.body.classList.contains('lab-open');
    const start = state.items.length;
    const newItems = supported.map((file) => {
      const id = `frame-${++state.seq}`;
      return {
        id,
        file,
        status: 'queued',
        stage: 'Queued',
        url: '',
        outBlob: null,
        outBytes: 0,
        inBytes: file.size,
        width: 0,
        height: 0,
        scaled: false,
        error: '',
        quality: state.quality,
        token: state.runToken,
        inputFormat: inputFormat(file),
        outName: outputName(file),
        fresh: true,
      };
    });

    state.items.push(...newItems);
    openLab(true);
    refs.grid.insertAdjacentHTML('beforeend', newItems.map((item, i) => cardMarkup(item, start + i)).join(''));
    updateCounts();
    if (skipped) toast(`${skipped} unsupported file${skipped === 1 ? '' : 's'} skipped.`);
    pump();
    if (!wasOpen) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function pump() {
    while (state.active < MAX_PARALLEL) {
      const next = state.items.find((item) => item.status === 'queued');
      if (!next) break;
      processItem(next);
    }
  }

  async function processItem(item) {
    if (item.status !== 'queued') return;
    const token = item.token;
    state.active += 1;
    item.status = 'working';
    item.stage = isHeic(item.file) ? (window.heic2any ? 'Decoding HEIC' : 'Loading decoder') : 'Reading photo';
    refreshCard(item);
    updateCounts();

    try {
      const bitmap = await decodeFile(item.file);
      if (token !== state.runToken) {
        if (typeof bitmap.close === 'function') bitmap.close();
        return;
      }
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      item.scaled = scale < 1;

      item.stage = 'Writing JPG';
      refreshCard(item);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('This browser could not create a canvas.');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);
      if (typeof bitmap.close === 'function') bitmap.close();

      const blob = await canvasToBlob(canvas, state.quality / 100);
      if (token !== state.runToken) return;
      item.outBlob = blob;
      item.outBytes = blob.size;
      item.width = width;
      item.height = height;
      item.quality = state.quality;
      item.url = URL.createObjectURL(blob);
      item.status = 'ready';
      item.stage = 'Ready';
      item.fresh = false;
      refreshCard(item);
    } catch (error) {
      console.error('Conversion failed:', error);
      item.status = 'error';
      item.error = isHeic(item.file)
        ? 'The HEIC could not be decoded. Try exporting the photo again from Photos.'
        : 'The image could not be read. It may be damaged or unsupported.';
      refreshCard(item);
    } finally {
      if (token === state.runToken) {
        state.active = Math.max(0, state.active - 1);
        updateCounts();
        pump();
      }
    }
  }

  const HEIC_DECODER_SOURCES = [
    'https://unpkg.com/heic2any@0.0.4/dist/heic2any.min.js',
    'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js',
  ];
  let heicLoader;

  function ensureHeicDecoder() {
    if (typeof window.heic2any === 'function') return Promise.resolve();
    if (heicLoader) return heicLoader;
    heicLoader = new Promise((resolve, reject) => {
      const trySource = (index) => {
        if (typeof window.heic2any === 'function') {
          resolve();
          return;
        }
        if (index >= HEIC_DECODER_SOURCES.length) {
          heicLoader = null;
          reject(new Error('The HEIC decoder could not be loaded.'));
          return;
        }
        const script = document.createElement('script');
        script.src = HEIC_DECODER_SOURCES[index];
        script.async = true;
        script.onload = () => {
          if (typeof window.heic2any === 'function') resolve();
          else trySource(index + 1);
        };
        script.onerror = () => {
          script.remove();
          trySource(index + 1);
        };
        document.head.appendChild(script);
      };
      trySource(0);
    });
    return heicLoader;
  }

  async function decodeFile(file) {
    if (isHeic(file)) {
      await ensureHeicDecoder();
      if (typeof window.heic2any !== 'function') {
        throw new Error('HEIC decoder did not load.');
      }
      const result = await window.heic2any({
        blob: file,
        toType: 'image/png',
      });
      const blob = Array.isArray(result) ? result[0] : result;
      if (!blob) throw new Error('HEIC decoder returned no image.');
      return await createImageBitmap(blob);
    }
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  }

  function canvasToBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('The browser could not encode the JPG.'));
      }, 'image/jpeg', quality);
    });
  }

  function triggerFilePicker() {
    refs.fileInput.value = '';
    refs.fileInput.click();
  }

  async function loadDemo() {
    if (state.demoLoading) return;
    state.demoLoading = true;
    refs.demoBtn.disabled = true;
    refs.demoBtn.textContent = 'Loading demo roll…';

    try {
      const names = ['IMG_4821.HEIC', 'IMG_4822.HEIC', 'IMG_4823.HEIC', 'IMG_4824.HEIC'];
      const files = await Promise.all(names.map(async (name, index) => {
        const response = await fetch(`resources/demo-0${index + 1}.heic`);
        if (!response.ok) throw new Error(`Demo photo ${index + 1} could not load.`);
        const blob = await response.blob();
        return new File([blob], name, { type: 'image/heic' });
      }));
      addFiles(files);
    } catch (error) {
      console.error(error);
      toast('The demo roll could not load. Choose a photo instead.');
    } finally {
      state.demoLoading = false;
      refs.demoBtn.disabled = false;
      refs.demoBtn.textContent = 'Try a 4-photo demo ↗';
    }
  }

  function downloadOne(item) {
    if (!item.url) return;
    const anchor = document.createElement('a');
    anchor.href = item.url;
    anchor.download = item.outName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    toast(`Saving ${item.outName}`);
  }

  async function downloadAll() {
    const ready = state.items.filter((item) => item.status === 'ready');
    if (!ready.length || state.zipping) return;
    if (ready.length === 1) {
      downloadOne(ready[0]);
      return;
    }

    state.zipping = true;
    refs.downloadAll.disabled = true;
    refs.downloadLabel.textContent = 'Building zip…';
    refs.downloadSize.textContent = '';
    try {
      const zip = await makeZip(ready);
      const url = URL.createObjectURL(zip);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'photoconvert-roll-001.zip';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
      toast(`${ready.length} JPGs ready in one zip.`);
    } catch (error) {
      console.error(error);
      toast('The zip could not be built. Download the prints one by one.');
    } finally {
      state.zipping = false;
      updateDownload();
    }
  }

  function makeZip(items) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const used = new Set();
    const now = new Date();
    const { time, date } = dosDateTime(now);

    return (async () => {
      for (const item of items) {
        const base = item.outName.replace(/\.jpg$/i, '');
        let name = `${base}.jpg`;
        let counter = 2;
        while (used.has(name.toLowerCase())) name = `${base}-${counter++}.jpg`;
        used.add(name.toLowerCase());

        const data = new Uint8Array(await item.outBlob.arrayBuffer());
        const nameBytes = encoder.encode(name);
        const crc = crc32(data);

        const local = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0, true);
        lv.setUint16(8, 0, true);
        lv.setUint16(10, time, true);
        lv.setUint16(12, date, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, data.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);
        local.set(nameBytes, 30);

        localParts.push(local, data);

        const central = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, time, true);
        cv.setUint16(14, date, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, offset, true);
        central.set(nameBytes, 46);
        centralParts.push(central);

        offset += local.length + data.length;
      }

      const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
      const end = new Uint8Array(22);
      const ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(4, 0, true);
      ev.setUint16(6, 0, true);
      ev.setUint16(8, items.length, true);
      ev.setUint16(10, items.length, true);
      ev.setUint32(12, centralSize, true);
      ev.setUint32(16, offset, true);
      ev.setUint16(20, 0, true);

      return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
    })();
  }

  function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  }

  let crcTable;
  function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
    return crcTable;
  }

  function crc32(bytes) {
    const table = getCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function closeQuality(returnFocus = false) {
    const wasOpen = !refs.qualityPanel.hidden;
    refs.qualityPanel.hidden = true;
    refs.qualityBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus && wasOpen) refs.qualityBtn.focus({ preventScroll: true });
  }

  function openQuality() {
    refs.qualityPanel.hidden = false;
    refs.qualityBtn.setAttribute('aria-expanded', 'true');
    syncQualityUi();
    refs.qualityRange.focus({ preventScroll: true });
  }

  function syncQualityUi() {
    refs.qualityValue.textContent = String(state.quality);
    refs.qualityBig.textContent = String(state.quality);
    refs.qualityRange.value = String(state.quality);
    $$('.preset-row button').forEach((button) => {
      button.classList.toggle('is-active', Number(button.dataset.quality) === state.quality);
    });
  }

  async function applyQuality(value) {
    const quality = Math.max(60, Math.min(100, Number(value) || 92));
    const busy = state.items.some((item) => item.status === 'queued' || item.status === 'working');
    if (busy) {
      syncQualityUi();
      toast('Let this roll finish developing first.');
      return;
    }
    if (quality === state.quality && state.items.every((item) => item.status === 'ready' || item.status === 'error')) {
      return;
    }
    state.quality = quality;
    syncQualityUi();
    closeQuality(true);

    state.items.forEach((item) => {
      if (item.url) URL.revokeObjectURL(item.url);
      item.url = '';
      item.outBlob = null;
      item.outBytes = 0;
      item.status = 'queued';
      item.stage = 'Queued';
      item.error = '';
      item.fresh = false;
    });
    renderGrid();
    updateCounts();
    pump();
    toast(`Re-developing at quality ${quality}.`);
  }

  function removeItem(id) {
    const index = state.items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = state.items.splice(index, 1);
    if (item.url) URL.revokeObjectURL(item.url);
    renderGrid();
    updateCounts();
    if (!state.items.length) {
      closeLab();
      toast('Roll cleared.');
    }
  }

  function resetRoll() {
    state.items.forEach((item) => { if (item.url) URL.revokeObjectURL(item.url); });
    state.items = [];
    state.active = 0;
    state.runToken += 1;
    state.zipping = false;
    state.quality = 92;
    state.seq = 0;
    refs.grid.innerHTML = '';
    syncQualityUi();
    updateCounts();
    closeLab();
    toast('New roll. Your old files were only ever in this tab.');
  }

  /* events */
  refs.heroChoose.addEventListener('click', triggerFilePicker);
  refs.trayChoose.addEventListener('click', (event) => {
    event.stopPropagation();
    triggerFilePicker();
  });
  refs.addBtn.addEventListener('click', triggerFilePicker);
  refs.demoBtn.addEventListener('click', loadDemo);
  refs.fileInput.addEventListener('change', () => addFiles(refs.fileInput.files));
  refs.downloadAll.addEventListener('click', downloadAll);
  refs.resetBtn.addEventListener('click', resetRoll);

  refs.grid.addEventListener('click', (event) => {
    const download = event.target.closest('[data-download]');
    if (download) {
      const item = itemById(download.dataset.download);
      if (item) downloadOne(item);
      return;
    }
    const remove = event.target.closest('[data-remove]');
    if (remove) removeItem(remove.dataset.remove);
  });

  refs.qualityBtn.addEventListener('click', () => {
    if (refs.qualityPanel.hidden) openQuality();
    else closeQuality();
  });
  refs.qualityRange.addEventListener('input', () => {
    refs.qualityBig.textContent = refs.qualityRange.value;
    refs.qualityValue.textContent = refs.qualityRange.value;
    $$('.preset-row button').forEach((button) => button.classList.remove('is-active'));
  });
  refs.qualityRange.addEventListener('change', () => applyQuality(refs.qualityRange.value));
  $$('.preset-row button').forEach((button) => {
    button.addEventListener('click', () => {
      const value = Number(button.dataset.quality);
      refs.qualityRange.value = String(value);
      applyQuality(value);
    });
  });

  document.addEventListener('click', (event) => {
    if (refs.qualityPanel.hidden) return;
    if (refs.qualityPanel.contains(event.target) || refs.qualityBtn.contains(event.target)) return;
    closeQuality();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeQuality(true);
  });

  /* whole-page drag and drop */
  let dragDepth = 0;
  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  document.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    refs.body.classList.add('is-dragging');
  });
  document.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) refs.body.classList.remove('is-dragging');
  });
  document.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    refs.body.classList.remove('is-dragging');
    addFiles(event.dataTransfer.files);
  });

  window.addEventListener('beforeunload', () => {
    state.items.forEach((item) => { if (item.url) URL.revokeObjectURL(item.url); });
  });

  const demoParam = new URLSearchParams(window.location.search).get('demo');
  if (demoParam === '1' || demoParam === 'true') {
    window.addEventListener('load', () => setTimeout(loadDemo, 150));
  }

  updateCounts();
})();
