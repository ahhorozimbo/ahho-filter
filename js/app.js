/* Interface do AHHO Filter: carregamento, visualização, parâmetros, pipeline e código. */
(function () {
  'use strict';

  const { CATEGORIES, FILTERS, PY_HEADER, PY_FOOTER, odd } = window.AHHO;
  const MAX_SIDE = 1600; // imagens maiores são reduzidas para manter o tempo real

  const $ = (id) => document.getElementById(id);
  const el = {
    status: $('cv-status'), list: $('filter-list'), search: $('filter-search'),
    file: $('file-input'), sample: $('btn-sample'), drop: $('dropzone'), viewer: $('viewer'),
    before: $('canvas-before'), after: $('canvas-after'), range: $('compare-range'),
    modeSlider: $('mode-slider'), modeSide: $('mode-side'),
    commit: $('btn-commit'), undo: $('btn-undo'), reset: $('btn-reset'), download: $('btn-download'),
    timing: $('timing'), pipeline: $('pipeline-list'), histo: $('histogram'),
    panel: $('panel'), panelEmpty: $('panel-empty'), cat: $('f-category'), name: $('f-name'), desc: $('f-desc'),
    params: $('f-params'), info: $('f-info'), defaults: $('btn-defaults'),
    theory: $('tab-theory'), codeFilter: $('code-filter'), codePipeline: $('code-pipeline'), toasts: $('toasts'),
  };

  const state = {
    cvReady: false,
    history: [],      // [{ image: ImageData, label, code: [linhas] }] — history[0] é a original
    filter: null,
    params: {},
    pending: false,
    lastOk: true,
  };
  const base = () => state.history[state.history.length - 1]?.image;

  // ---------------- Avisos (com orientação de como resolver) ----------------
  function toast(type, title, msg, fix, ms = 7000) {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<button class="close" aria-label="Fechar">×</button><strong></strong><span></span>${fix ? '<p class="fix"></p>' : ''}`;
    t.querySelector('strong').textContent = title;
    t.querySelector('span').textContent = msg;
    if (fix) t.querySelector('.fix').textContent = 'Como resolver: ' + fix;
    t.querySelector('.close').onclick = () => t.remove();
    el.toasts.appendChild(t);
    if (ms) setTimeout(() => t.remove(), ms);
  }

  function cvErrorMessage(err) {
    if (typeof err === 'number' && window.cv?.exceptionFromPtr) {
      try { return cv.exceptionFromPtr(err).msg; } catch (_) { /* ignora */ }
    }
    return err?.message || String(err);
  }

  // ---------------- Carregamento do OpenCV.js ----------------
  function setStatus(kind, text) {
    el.status.className = `cv-status ${kind}`;
    el.status.querySelector('.txt').textContent = text;
  }

  function onCvReady() {
    if (state.cvReady) return;
    state.cvReady = true;
    clearTimeout(cvTimeout);
    setStatus('ready', `OpenCV ${cv.getBuildInformation?.().match(/General configuration for OpenCV ([\d.]+)/)?.[1] || ''} pronto`);
    scheduleRender();
  }

  window.onOpenCvScriptLoaded = async function () {
    try {
      if (window.cv instanceof Promise) window.cv = await window.cv;
      if (window.cv?.Mat) onCvReady();
      else window.cv.onRuntimeInitialized = onCvReady;
    } catch (e) {
      window.onOpenCvScriptError(e);
    }
  };

  window.onOpenCvScriptError = function () {
    setStatus('error', 'OpenCV não carregou');
    toast('error', 'Não foi possível carregar o OpenCV.js',
      'A biblioteca (cerca de 10 MB) é baixada da internet na primeira vez que a página abre.',
      'verifique sua conexão e recarregue a página (F5). Se estiver em uma rede escolar com bloqueio, peça a liberação de cdn.jsdelivr.net.', 0);
  };

  const cvTimeout = setTimeout(() => {
    if (!state.cvReady) toast('warn', 'O OpenCV está demorando para carregar',
      'Em conexões lentas o download pode levar alguns minutos.', 'aguarde mais um pouco; se nada mudar, recarregue a página.', 10000);
  }, 30000);

  // ---------------- Catálogo ----------------
  function buildCatalog() {
    el.list.innerHTML = '';
    for (const c of CATEGORIES) {
      const items = FILTERS.filter((f) => f.category === c.id);
      const title = document.createElement('div');
      title.className = 'cat-title'; title.dataset.cat = c.id;
      title.innerHTML = '<span></span><span class="count"></span>';
      title.firstChild.textContent = c.name; title.lastChild.textContent = items.length;
      el.list.appendChild(title);
      for (const f of items) {
        const b = document.createElement('button');
        b.className = 'filter-btn'; b.textContent = f.name; b.dataset.id = f.id; b.dataset.cat = c.id;
        b.onclick = () => selectFilter(f.id);
        el.list.appendChild(b);
      }
    }
  }

  el.search.addEventListener('input', () => {
    const q = el.search.value.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const norm = (s) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const visibleCats = new Set();
    el.list.querySelectorAll('.filter-btn').forEach((b) => {
      const f = FILTERS.find((x) => x.id === b.dataset.id);
      const show = !q || norm(f.name + ' ' + f.description).includes(q);
      b.hidden = !show;
      if (show) visibleCats.add(b.dataset.cat);
    });
    el.list.querySelectorAll('.cat-title').forEach((t) => { t.hidden = !visibleCats.has(t.dataset.cat); });
  });

  // ---------------- Painel do filtro ----------------
  function defaultParams(f) {
    const p = {};
    for (const d of f.params) p[d.id] = d.value;
    return p;
  }

  function selectFilter(id) {
    state.filter = id ? FILTERS.find((f) => f.id === id) : null;
    el.list.querySelectorAll('.filter-btn').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
    if (!state.filter) {
      el.panel.hidden = true; el.panelEmpty.hidden = false;
      updatePipelineView(); scheduleRender();
      return;
    }
    state.params = defaultParams(state.filter);
    el.panel.hidden = false; el.panelEmpty.hidden = true;
    const f = state.filter;
    el.cat.textContent = CATEGORIES.find((c) => c.id === f.category).name;
    el.name.textContent = f.name;
    el.desc.textContent = f.description;
    buildParams();
    updateExplanation();
    updatePipelineView();
    if (!base()) toast('info', 'Carregue uma imagem', 'O filtro será aplicado assim que houver uma imagem.', 'clique em "Carregar imagem" ou em "Usar imagem de exemplo".', 4000);
    scheduleRender();
  }

  function buildParams() {
    const f = state.filter;
    el.params.innerHTML = '';
    for (const d of f.params) {
      const wrap = document.createElement('div');
      wrap.className = 'param' + (d.type === 'check' ? ' check' : '');
      const inputId = `p-${d.id}`;
      if (d.type === 'range') {
        wrap.innerHTML = `<label for="${inputId}"><span></span><output></output></label>
          <input id="${inputId}" type="range" min="${d.min}" max="${d.max}" step="${d.step}" value="${state.params[d.id]}">`;
        wrap.querySelector('output').textContent = state.params[d.id];
      } else if (d.type === 'select') {
        wrap.innerHTML = `<label for="${inputId}"><span></span></label><select id="${inputId}"></select>`;
        const s = wrap.querySelector('select');
        for (const o of d.options) s.add(new Option(o.label, o.value, false, o.value === state.params[d.id]));
      } else {
        wrap.innerHTML = `<label><input id="${inputId}" type="checkbox" ${state.params[d.id] ? 'checked' : ''}><span></span></label>`;
      }
      wrap.querySelector('span').textContent = d.label;
      if (d.hint) { const h = document.createElement('p'); h.className = 'hint'; h.textContent = d.hint; wrap.appendChild(h); }
      const input = wrap.querySelector('input, select');
      input.addEventListener('input', () => onParamInput(d, input, wrap));
      el.params.appendChild(wrap);
    }
    const w = document.createElement('p'); w.className = 'warn'; w.id = 'param-warn'; w.hidden = true;
    el.params.appendChild(w);
  }

  function onParamInput(d, input, wrap) {
    let v;
    if (d.type === 'range') {
      v = parseFloat(input.value);
      if (d.odd && v % 2 === 0) { v = Math.min(odd(v), d.max); input.value = v; }
      wrap.querySelector('output').textContent = v;
    } else if (d.type === 'check') v = input.checked;
    else v = input.value;
    state.params[d.id] = v;
    updateExplanation();
    scheduleRender();
  }

  el.defaults.onclick = () => { if (state.filter) selectFilter(state.filter.id); };

  function kernelTable(k) {
    const rows = k.m.map((r) => `<tr>${r.map((v) => `<td>${v}</td>`).join('')}</tr>`).join('');
    return `<table class="kernel"><caption>${k.title}</caption>${rows}</table>`;
  }

  function updateExplanation() {
    const f = state.filter; if (!f) return;
    const p = state.params;
    const kernels = f.kernel ? f.kernel(p) : null;
    el.theory.innerHTML = f.theory(p) + (kernels ? `<div class="kernels">${kernels.map(kernelTable).join('')}</div>` : '');
    const warnEl = $('param-warn');
    const warn = f.warn ? f.warn(p) : null;
    warnEl.hidden = !warn; warnEl.textContent = warn || '';
    el.codeFilter.textContent = [...PY_HEADER, '', ...f.code(p), ...PY_FOOTER].join('\n');
    el.codePipeline.textContent = pipelineScript();
  }

  function pipelineScript() {
    const lines = [...PY_HEADER];
    let n = 0;
    for (const step of state.history.slice(1)) lines.push('', `# ${++n}. ${step.label}`, ...step.code);
    if (state.filter) lines.push('', `# ${++n}. ${state.filter.name} (atual, ainda não fixado)`, ...state.filter.code(state.params));
    return [...lines, ...PY_FOOTER].join('\n');
  }

  // Abas
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b); });
      for (const t of ['theory', 'code', 'pipeline']) $(`tab-${t}`).hidden = t !== b.dataset.tab;
    };
  });
  document.querySelectorAll('.copy').forEach((b) => {
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText($(b.dataset.copy).textContent);
        b.textContent = 'Copiado!'; setTimeout(() => { b.textContent = 'Copiar'; }, 1500);
      } catch (_) {
        toast('warn', 'Não foi possível copiar', 'O navegador bloqueou o acesso à área de transferência.', 'selecione o código com o mouse e use Ctrl+C.');
      }
    };
  });

  // ---------------- Imagem ----------------
  function loadImageElement(img, label) {
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error('Imagem vazia');
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    if (scale < 1) {
      toast('info', 'Imagem reduzida', `A imagem tinha ${w}×${h} pixels e foi reduzida para ${Math.round(w * scale)}×${Math.round(h * scale)} para o processamento continuar em tempo real.`, null, 5000);
      w = Math.round(w * scale); h = Math.round(h * scale);
    }
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
    setOriginal(ctx.getImageData(0, 0, w, h), label);
  }

  function setOriginal(imageData, label) {
    state.history = [{ image: imageData, label: label || 'Original', code: [] }];
    el.viewer.hidden = false;
    el.drop.classList.add('has-image');
    el.drop.querySelector('.empty').hidden = true;
    updateButtons(); updatePipelineView(); updateExplanation();
    scheduleRender();
  }

  function loadFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('error', 'Formato não suportado', `"${file.name}" não parece ser uma imagem.`, 'use um arquivo JPG, PNG, WEBP, GIF ou BMP.');
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try { loadImageElement(img, file.name); } catch (e) {
        toast('error', 'Não foi possível abrir a imagem', cvErrorMessage(e), 'tente outro arquivo ou salve a imagem novamente em PNG/JPG.');
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast('error', 'Não foi possível ler a imagem', `O navegador não conseguiu decodificar "${file.name}".`,
        'formatos como HEIC (iPhone) e TIFF não são aceitos pelos navegadores; converta para JPG ou PNG.');
    };
    img.src = url;
  }

  el.file.addEventListener('change', () => { loadFile(el.file.files[0]); el.file.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.remove('drag'); }));
  el.drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });

  // Imagem de exemplo desenhada no próprio navegador (sem direitos autorais envolvidos)
  el.sample.onclick = () => {
    const w = 720, h = 480;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, h * 0.6);
    sky.addColorStop(0, '#2b5fa8'); sky.addColorStop(1, '#f2b880');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffe27a'; g.beginPath(); g.arc(560, 110, 48, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#4d5b74'; g.beginPath(); g.moveTo(0, 300); g.lineTo(150, 160); g.lineTo(300, 290); g.lineTo(430, 190); g.lineTo(620, 300); g.lineTo(720, 240); g.lineTo(720, 480); g.lineTo(0, 480); g.fill();
    const grass = g.createLinearGradient(0, 300, 0, h);
    grass.addColorStop(0, '#5e9c4a'); grass.addColorStop(1, '#2f5a25');
    g.fillStyle = grass; g.fillRect(0, 310, w, h - 310);
    g.fillStyle = '#d9d2c3'; g.fillRect(120, 300, 150, 110);
    g.fillStyle = '#a2402f'; g.beginPath(); g.moveTo(105, 300); g.lineTo(195, 235); g.lineTo(285, 300); g.fill();
    g.fillStyle = '#5a3a22'; g.fillRect(180, 350, 32, 60);
    g.fillStyle = '#7fc4e8'; g.fillRect(135, 320, 32, 28); g.fillRect(225, 320, 32, 28);
    const colors = ['#e63946', '#f1c40f', '#2a9d8f', '#8e44ad', '#ffffff', '#111111'];
    colors.forEach((col, i) => { g.fillStyle = col; g.beginPath(); g.arc(380 + i * 52, 400, 20, 0, Math.PI * 2); g.fill(); });
    for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) { g.fillStyle = (x + y) % 2 ? '#222' : '#eee'; g.fillRect(40 + x * 12, 40 + y * 12, 12, 12); }
    g.fillStyle = '#ffffff'; g.font = 'bold 44px system-ui, sans-serif'; g.fillText('AHHO', 330, 340);
    g.strokeStyle = '#1b1b1b'; g.lineWidth = 2; g.strokeText('AHHO', 330, 340);
    setOriginal(g.getImageData(0, 0, w, h), 'Imagem de exemplo');
  };

  // ---------------- Processamento ----------------
  function scheduleRender() {
    if (state.pending) return;
    state.pending = true;
    // setTimeout em vez de requestAnimationFrame: o rAF fica pausado em abas ocultas.
    setTimeout(() => { state.pending = false; render(); }, 0);
  }

  function drawImageData(canvas, data) {
    canvas.width = data.width; canvas.height = data.height;
    canvas.getContext('2d').putImageData(data, 0, 0);
  }

  function render() {
    const img = base();
    if (!img) return;
    drawImageData(el.before, img);
    el.info.hidden = true;

    if (!state.filter || !state.cvReady) {
      drawImageData(el.after, img);
      el.timing.textContent = state.filter && !state.cvReady ? 'Aguardando o OpenCV carregar…' : '';
      updateButtons(); drawHistogram();
      return;
    }

    let rgba, src, dst;
    try {
      rgba = cv.matFromImageData(img);
      src = new cv.Mat(); dst = new cv.Mat();
      cv.cvtColor(rgba, src, cv.COLOR_RGBA2RGB);
      const t0 = performance.now();
      const info = state.filter.apply(src, dst, state.params);
      const ms = performance.now() - t0;
      cv.imshow(el.after, dst);
      el.timing.textContent = `${state.filter.name}: ${ms.toFixed(1)} ms · ${img.width}×${img.height} px · ${dst.channels() === 1 ? '1 canal (cinza)' : '3 canais (cor)'}`;
      if (info) { el.info.textContent = info; el.info.hidden = false; }
      state.lastOk = true;
    } catch (e) {
      state.lastOk = false;
      drawImageData(el.after, img);
      el.timing.textContent = 'Falha ao aplicar o filtro';
      toast('error', `Erro ao aplicar "${state.filter.name}"`, `Detalhe técnico: ${cvErrorMessage(e)}`,
        'clique em "Restaurar valores padrão". Se o erro continuar, tente uma imagem menor ou outro filtro e avise o professor com o detalhe acima.');
    } finally {
      rgba?.delete(); src?.delete(); dst?.delete();
    }
    updateButtons(); drawHistogram();
  }

  // ---------------- Pipeline ----------------
  el.commit.onclick = () => {
    if (!state.filter || !state.lastOk) return;
    const data = el.after.getContext('2d').getImageData(0, 0, el.after.width, el.after.height);
    state.history.push({ image: data, label: state.filter.name, code: state.filter.code(state.params) });
    selectFilter(null);
    toast('info', 'Passo adicionado ao pipeline', 'O resultado agora é a entrada do próximo filtro.', null, 2500);
  };
  el.undo.onclick = () => {
    if (state.history.length > 1) state.history.pop();
    updatePipelineView(); updateExplanation(); scheduleRender();
  };
  el.reset.onclick = () => {
    state.history = state.history.slice(0, 1);
    selectFilter(null);
  };
  el.download.onclick = () => {
    el.after.toBlob((blob) => {
      if (!blob) { toast('error', 'Falha ao gerar o arquivo', 'O navegador não conseguiu exportar a imagem.', 'tente novamente ou clique com o botão direito na imagem e escolha "Salvar imagem como".'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ahho-${state.filter?.id || 'resultado'}.png`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  };

  function updatePipelineView() {
    el.pipeline.innerHTML = '';
    const items = state.history.map((s) => s.label);
    items.forEach((label, i) => {
      const li = document.createElement('li'); li.textContent = i === 0 ? 'Original' : label;
      el.pipeline.appendChild(li);
    });
    if (state.filter && base()) {
      const li = document.createElement('li'); li.className = 'current'; li.textContent = state.filter.name + ' (prévia)';
      el.pipeline.appendChild(li);
    }
    updateButtons();
  }

  function updateButtons() {
    const has = !!base();
    el.commit.disabled = !(has && state.filter && state.cvReady && state.lastOk);
    el.undo.disabled = state.history.length <= 1;
    el.reset.disabled = !has || (state.history.length <= 1 && !state.filter);
    el.download.disabled = !has;
  }

  // ---------------- Comparação ----------------
  el.range.addEventListener('input', () => el.viewer.style.setProperty('--split', el.range.value + '%'));
  function setMode(mode) {
    el.viewer.classList.toggle('mode-slider', mode === 'slider');
    el.viewer.classList.toggle('mode-side', mode === 'side');
    el.modeSlider.classList.toggle('active', mode === 'slider'); el.modeSlider.setAttribute('aria-pressed', mode === 'slider');
    el.modeSide.classList.toggle('active', mode === 'side'); el.modeSide.setAttribute('aria-pressed', mode === 'side');
  }
  el.modeSlider.onclick = () => setMode('slider');
  el.modeSide.onclick = () => setMode('side');

  // ---------------- Histograma ----------------
  function luminanceHistogram(data) {
    const h = new Uint32Array(256); const d = data.data;
    for (let i = 0; i < d.length; i += 4) h[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++;
    return h;
  }
  function drawHistogram() {
    const img = base(); if (!img) return;
    const a = luminanceHistogram(img);
    const b = luminanceHistogram(el.after.getContext('2d').getImageData(0, 0, el.after.width, el.after.height));
    const c = el.histo, g = c.getContext('2d'), W = c.width, H = c.height;
    const max = Math.max(...a, ...b) || 1;
    const css = getComputedStyle(document.documentElement);
    g.clearRect(0, 0, W, H);
    for (const [hist, color] of [[a, css.getPropertyValue('--before')], [b, css.getPropertyValue('--after')]]) {
      g.fillStyle = color.trim();
      for (let i = 0; i < 256; i++) {
        const bh = Math.max(hist[i] ? 1 : 0, Math.round((hist[i] / max) * (H - 2)));
        g.fillRect(i * (W / 256), H - bh, W / 256, bh);
      }
    }
  }

  // ---------------- Início ----------------
  buildCatalog();
  updateButtons();
})();
