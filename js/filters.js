/*
 * Catálogo de filtros do AHHO Filter.
 *
 * Cada filtro descreve:
 *  - id, name, category, description: identificação e resumo
 *  - params: lista de parâmetros ({ id, label, type: 'range'|'select'|'check', ... })
 *  - theory(p): HTML explicando o conceito (pode usar os valores atuais dos parâmetros)
 *  - kernel(p): (opcional) matriz(es) de convolução para exibir
 *  - apply(src, dst, p): processa com OpenCV.js; src é sempre RGB 8 bits (CV_8UC3).
 *                        Pode retornar um texto informativo (ex.: limiar calculado).
 *  - code(p): linhas Python equivalentes, que leem e atualizam a variável `img`.
 *
 * Toda Mat criada aqui precisa de .delete() — OpenCV.js não tem coletor de lixo para elas.
 */
(function () {
  'use strict';

  const CATEGORIES = [
    { id: 'realce', name: 'Realce' },
    { id: 'suavizacao', name: 'Suavização' },
    { id: 'cor', name: 'Cor' },
    { id: 'limiar', name: 'Limiarização' },
    { id: 'bordas', name: 'Detecção de bordas' },
    { id: 'segmentacao', name: 'Morfologia e segmentação' },
    { id: 'ruido', name: 'Ruído (para experimentos)' },
  ];

  // ---------- utilidades ----------
  const odd = (n) => (n % 2 === 1 ? n : n + 1);
  const fmt = (n) => (Number.isInteger(n) ? String(n) : String(+n.toFixed(3)));

  function gray(src) {
    const g = new cv.Mat();
    cv.cvtColor(src, g, cv.COLOR_RGB2GRAY);
    return g;
  }

  // Gerador pseudoaleatório com semente fixa: o ruído não "pisca" ao mexer no slider.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Aplica um kernel em tons de cinza (Prewitt/Roberts) e devolve |resposta|.
  function convAbs(g, values, rows, cols) {
    const k = cv.matFromArray(rows, cols, cv.CV_32F, values);
    const r = new cv.Mat();
    const out = new cv.Mat();
    cv.filter2D(g, r, cv.CV_16S, k);
    cv.convertScaleAbs(r, out);
    k.delete(); r.delete();
    return out;
  }

  function combineDirections(gx, gy, dir, dst) {
    if (dir === 'x') gx.copyTo(dst);
    else if (dir === 'y') gy.copyTo(dst);
    else cv.addWeighted(gx, 0.5, gy, 0.5, 0, dst);
  }

  function gaussianKernel1D(k, sigma) {
    const s = sigma > 0 ? sigma : 0.3 * ((k - 1) * 0.5 - 1) + 0.8; // mesma regra do OpenCV
    const c = (k - 1) / 2;
    const v = [];
    let sum = 0;
    for (let i = 0; i < k; i++) { const x = i - c; const e = Math.exp(-(x * x) / (2 * s * s)); v.push(e); sum += e; }
    return v.map((x) => x / sum);
  }

  const DIRECTION = {
    id: 'dir', label: 'Direção', type: 'select', value: 'mag',
    options: [
      { value: 'x', label: 'Horizontal (Gx) — bordas verticais' },
      { value: 'y', label: 'Vertical (Gy) — bordas horizontais' },
      { value: 'mag', label: 'Magnitude (Gx e Gy combinados)' },
    ],
  };

  function pyCombine(dir) {
    if (dir === 'x') return 'img = cv2.convertScaleAbs(gx)';
    if (dir === 'y') return 'img = cv2.convertScaleAbs(gy)';
    return 'img = cv2.addWeighted(cv2.convertScaleAbs(gx), 0.5, cv2.convertScaleAbs(gy), 0.5, 0)';
  }

  // ---------- filtros ----------
  const FILTERS = [
    // ===== Realce =====
    {
      id: 'brilho-contraste', category: 'realce', name: 'Brilho e contraste',
      description: 'Transformação linear da intensidade de cada pixel.',
      params: [
        { id: 'alpha', label: 'Contraste (α)', type: 'range', min: 0, max: 3, step: 0.05, value: 1.3, hint: 'α > 1 aumenta o contraste; α < 1 reduz.' },
        { id: 'beta', label: 'Brilho (β)', type: 'range', min: -100, max: 100, step: 1, value: 20, hint: 'Valor somado a todos os pixels.' },
      ],
      theory: (p) => `
        <p>É uma <b>operação pontual</b>: o novo valor de cada pixel depende apenas do valor antigo dele mesmo.</p>
        <p class="formula">g(x,y) = α · f(x,y) + β = ${fmt(p.alpha)} · f(x,y) ${p.beta >= 0 ? '+' : '−'} ${Math.abs(p.beta)}</p>
        <p>Resultados menores que 0 viram 0 e maiores que 255 viram 255 (<i>saturação</i>). Repare no histograma: β desloca as barras, α as espalha ou comprime.</p>`,
      apply: (src, dst, p) => src.convertTo(dst, -1, p.alpha, p.beta),
      code: (p) => [`img = np.clip(img.astype(np.float32) * ${fmt(p.alpha)} + ${p.beta}, 0, 255).astype(np.uint8)`],
    },
    {
      id: 'gamma', category: 'realce', name: 'Correção gama',
      description: 'Transformação de potência: clareia ou escurece os tons médios.',
      params: [
        { id: 'gamma', label: 'Gama (γ)', type: 'range', min: 0.1, max: 3, step: 0.05, value: 0.6, hint: 'γ < 1 clareia as sombras; γ > 1 escurece.' },
      ],
      theory: (p) => `
        <p>Com a intensidade normalizada entre 0 e 1, aplica-se uma potência:</p>
        <p class="formula">s = r<sup>γ</sup> &nbsp;(γ = ${fmt(p.gamma)})</p>
        <p>Diferente do brilho, preto continua preto e branco continua branco; só a curva entre eles muda. Por eficiência, calcula-se uma <b>tabela de consulta (LUT)</b> de 256 posições e cada pixel é apenas consultado nela.</p>`,
      apply: (src, dst, p) => {
        const table = new Uint8Array(256);
        for (let i = 0; i < 256; i++) table[i] = Math.round(Math.pow(i / 255, p.gamma) * 255);
        src.copyTo(dst);
        const d = dst.data;
        for (let i = 0; i < d.length; i++) d[i] = table[d[i]];
      },
      code: (p) => [
        `tabela = np.array([((i / 255.0) ** ${fmt(p.gamma)}) * 255 for i in range(256)]).astype(np.uint8)`,
        'img = cv2.LUT(img, tabela)',
      ],
    },
    {
      id: 'equalizacao', category: 'realce', name: 'Equalização de histograma',
      description: 'Redistribui as intensidades para usar toda a faixa de 0 a 255.',
      params: [
        { id: 'mode', label: 'Aplicar em', type: 'select', value: 'gray', options: [
          { value: 'gray', label: 'Tons de cinza' },
          { value: 'color', label: 'Imagem colorida (só a luminância)' },
        ] },
      ],
      theory: () => `
        <p>Usa a <b>função de distribuição acumulada</b> (CDF) do histograma como transformação:</p>
        <p class="formula">s<sub>k</sub> = 255 · Σ<sub>j≤k</sub> p(r<sub>j</sub>)</p>
        <p>Intensidades muito frequentes são "espalhadas", aumentando o contraste global. Observe como o histograma fica mais uniforme.</p>
        <p>Em imagens coloridas, equalizar R, G e B separadamente distorce as cores; por isso convertemos para <b>YCrCb</b> e equalizamos apenas o canal Y (luminância).</p>`,
      apply: (src, dst, p) => {
        if (p.mode === 'gray') {
          const g = gray(src); cv.equalizeHist(g, dst); g.delete(); return;
        }
        const y = new cv.Mat(); const ch = new cv.MatVector();
        cv.cvtColor(src, y, cv.COLOR_RGB2YCrCb);
        cv.split(y, ch);
        const c0 = ch.get(0); cv.equalizeHist(c0, c0); ch.set(0, c0);
        cv.merge(ch, y);
        cv.cvtColor(y, dst, cv.COLOR_YCrCb2RGB);
        c0.delete(); y.delete(); ch.delete();
      },
      code: (p) => p.mode === 'gray'
        ? ['img = cv2.equalizeHist(cinza(img))']
        : ['ycrcb = cv2.cvtColor(cor(img), cv2.COLOR_BGR2YCrCb)',
           'ycrcb[:, :, 0] = cv2.equalizeHist(ycrcb[:, :, 0])',
           'img = cv2.cvtColor(ycrcb, cv2.COLOR_YCrCb2BGR)'],
    },
    {
      id: 'clahe', category: 'realce', name: 'CLAHE (equalização adaptativa)',
      description: 'Equalização feita em blocos, com limite de contraste.',
      params: [
        { id: 'clip', label: 'Limite de contraste', type: 'range', min: 1, max: 10, step: 0.5, value: 2, hint: 'Quanto maior, mais forte o realce (e o ruído).' },
        { id: 'tiles', label: 'Grade de blocos', type: 'range', min: 2, max: 16, step: 1, value: 8, hint: 'A imagem é dividida em N × N regiões.' },
      ],
      theory: (p) => `
        <p><b>Contrast Limited Adaptive Histogram Equalization.</b> A imagem é dividida em ${p.tiles} × ${p.tiles} blocos e cada um é equalizado separadamente, realçando detalhes locais que a equalização global não alcança.</p>
        <p>Para não amplificar ruído em regiões uniformes, o histograma de cada bloco é "cortado" no limite de contraste (${fmt(p.clip)}) e o excesso é redistribuído. As bordas entre blocos são suavizadas por interpolação bilinear.</p>`,
      apply: (src, dst, p) => {
        const g = gray(src);
        const clahe = new cv.CLAHE(p.clip, new cv.Size(p.tiles, p.tiles));
        clahe.apply(g, dst);
        clahe.delete(); g.delete();
      },
      code: (p) => [
        `clahe = cv2.createCLAHE(clipLimit=${fmt(p.clip)}, tileGridSize=(${p.tiles}, ${p.tiles}))`,
        'img = clahe.apply(cinza(img))',
      ],
    },
    {
      id: 'nitidez', category: 'realce', name: 'Nitidez (máscara de desfoque)',
      description: 'Realça detalhes somando a diferença entre a imagem e sua versão borrada.',
      params: [
        { id: 'amount', label: 'Intensidade', type: 'range', min: 0, max: 3, step: 0.1, value: 1, hint: 'Peso k dado aos detalhes.' },
        { id: 'sigma', label: 'Raio do desfoque (σ)', type: 'range', min: 0.5, max: 10, step: 0.5, value: 3, hint: 'Define o tamanho dos detalhes realçados.' },
      ],
      theory: (p) => `
        <p>Técnica clássica da fotografia (<i>unsharp masking</i>). Borra-se a imagem; o que sumiu no desfoque são os <b>detalhes</b> (altas frequências):</p>
        <p class="formula">máscara = f − borrada &nbsp;&nbsp; g = f + k · máscara</p>
        <p>Rearranjando: g = (1 + k)·f − k·borrada, com k = ${fmt(p.amount)}. Valores altos criam "halos" nas bordas.</p>`,
      apply: (src, dst, p) => {
        const b = new cv.Mat();
        cv.GaussianBlur(src, b, new cv.Size(0, 0), p.sigma);
        cv.addWeighted(src, 1 + p.amount, b, -p.amount, 0, dst);
        b.delete();
      },
      code: (p) => [
        `borrada = cv2.GaussianBlur(img, (0, 0), ${fmt(p.sigma)})`,
        `img = cv2.addWeighted(img, ${fmt(1 + p.amount)}, borrada, ${fmt(-p.amount)}, 0)`,
      ],
    },

    // ===== Suavização =====
    {
      id: 'media', category: 'suavizacao', name: 'Filtro da média',
      description: 'Cada pixel vira a média da sua vizinhança.',
      params: [
        { id: 'k', label: 'Tamanho do kernel', type: 'range', min: 1, max: 31, step: 1, value: 5, hint: 'Vizinhança de k × k pixels.' },
      ],
      kernel: (p) => p.k <= 7 ? [{ title: `Kernel ${p.k}×${p.k} (cada valor × 1/${p.k * p.k})`, m: Array.from({ length: p.k }, () => Array(p.k).fill(1)) }] : null,
      theory: (p) => `
        <p>É uma <b>convolução</b>: um kernel desliza sobre a imagem e cada pixel de saída é a soma ponderada dos vizinhos. No filtro da média todos os pesos são iguais:</p>
        <p class="formula">g(x,y) = (1/${p.k * p.k}) · Σ f(x+i, y+j)</p>
        <p>Remove ruído, mas também borra bordas. Kernels maiores borram mais.</p>`,
      apply: (src, dst, p) => cv.blur(src, dst, new cv.Size(p.k, p.k)),
      code: (p) => [`img = cv2.blur(img, (${p.k}, ${p.k}))`],
    },
    {
      id: 'gaussiano', category: 'suavizacao', name: 'Filtro gaussiano',
      description: 'Média ponderada: vizinhos mais próximos pesam mais.',
      params: [
        { id: 'k', label: 'Tamanho do kernel', type: 'range', min: 1, max: 31, step: 2, value: 5, odd: true, hint: 'Precisa ser ímpar para ter um pixel central.' },
        { id: 'sigma', label: 'Desvio padrão (σ)', type: 'range', min: 0, max: 10, step: 0.1, value: 0, hint: '0 = calculado automaticamente a partir do tamanho.' },
      ],
      kernel: (p) => {
        if (p.k > 7) return null;
        const v = gaussianKernel1D(p.k, p.sigma);
        return [{ title: `Kernel ${p.k}×${p.k} (valores somam 1)`, m: v.map((a) => v.map((b) => +(a * b).toFixed(3))) }];
      },
      theory: (p) => `
        <p>Os pesos seguem uma <b>gaussiana 2D</b>:</p>
        <p class="formula">G(x,y) = (1 / 2πσ²) · e<sup>−(x² + y²) / 2σ²</sup></p>
        <p>Borra de forma mais natural que a média e preserva melhor a estrutura. É o pré-processamento padrão antes de detectores de borda como Canny. ${p.sigma === 0 ? 'Com σ = 0, o OpenCV calcula σ a partir do tamanho do kernel.' : ''}</p>`,
      apply: (src, dst, p) => cv.GaussianBlur(src, dst, new cv.Size(p.k, p.k), p.sigma, p.sigma, cv.BORDER_DEFAULT),
      code: (p) => [`img = cv2.GaussianBlur(img, (${p.k}, ${p.k}), ${fmt(p.sigma)})`],
    },
    {
      id: 'mediana', category: 'suavizacao', name: 'Filtro da mediana',
      description: 'Cada pixel vira a mediana da vizinhança. Ótimo contra ruído sal e pimenta.',
      params: [
        { id: 'k', label: 'Tamanho da janela', type: 'range', min: 3, max: 15, step: 2, value: 5, odd: true },
      ],
      theory: () => `
        <p>Filtro <b>não linear</b>: ordena os valores da vizinhança e escolhe o do meio. Um pixel isolado muito claro ou muito escuro (ruído impulsivo) nunca é a mediana, então desaparece.</p>
        <p>Experimente: aplique <i>Ruído sal e pimenta</i>, clique em "Aplicar e continuar" e compare <i>Média</i> com <i>Mediana</i>. A mediana remove o ruído preservando as bordas.</p>`,
      apply: (src, dst, p) => cv.medianBlur(src, dst, p.k),
      code: (p) => [`img = cv2.medianBlur(img, ${p.k})`],
    },
    {
      id: 'bilateral', category: 'suavizacao', name: 'Filtro bilateral',
      description: 'Suaviza regiões uniformes preservando as bordas.',
      params: [
        { id: 'd', label: 'Diâmetro da vizinhança', type: 'range', min: 1, max: 15, step: 1, value: 9, hint: 'Valores altos ficam lentos em imagens grandes.' },
        { id: 'sc', label: 'σ de cor', type: 'range', min: 1, max: 200, step: 1, value: 75, hint: 'Diferença de cor tolerada entre vizinhos.' },
        { id: 'ss', label: 'σ de espaço', type: 'range', min: 1, max: 200, step: 1, value: 75, hint: 'Alcance espacial da suavização.' },
      ],
      theory: () => `
        <p>Combina dois pesos gaussianos: um pela <b>distância</b> (como o gaussiano) e outro pela <b>diferença de cor</b>. Vizinhos com cor muito diferente (do outro lado de uma borda) quase não contribuem.</p>
        <p>Resultado: aparência "pintada", com superfícies lisas e contornos nítidos. É bem mais custoso computacionalmente; observe o tempo de processamento.</p>`,
      apply: (src, dst, p) => cv.bilateralFilter(src, dst, p.d, p.sc, p.ss, cv.BORDER_DEFAULT),
      code: (p) => [`img = cv2.bilateralFilter(cor(img), ${p.d}, ${p.sc}, ${p.ss})`],
    },

    // ===== Cor =====
    {
      id: 'cinza', category: 'cor', name: 'Escala de cinza',
      description: 'Converte a imagem colorida em tons de cinza.',
      params: [],
      theory: () => `
        <p>Não é uma média simples: o olho humano é mais sensível ao verde. O OpenCV usa a ponderação do padrão ITU-R BT.601:</p>
        <p class="formula">Y = 0,299·R + 0,587·G + 0,114·B</p>
        <p>A imagem passa a ter <b>um canal</b> em vez de três. Muitos algoritmos (limiarização, bordas) trabalham sobre ela.</p>`,
      apply: (src, dst) => cv.cvtColor(src, dst, cv.COLOR_RGB2GRAY),
      code: () => ['img = cinza(img)'],
    },
    {
      id: 'negativo', category: 'cor', name: 'Negativo',
      description: 'Inverte as intensidades de cada canal.',
      params: [],
      theory: () => `
        <p>Para imagens de 8 bits (L = 256 níveis):</p>
        <p class="formula">s = (L − 1) − r = 255 − r</p>
        <p>Útil para destacar detalhes claros em regiões escuras, como em mamografias e radiografias.</p>`,
      apply: (src, dst) => cv.bitwise_not(src, dst),
      code: () => ['img = cv2.bitwise_not(img)'],
    },
    {
      id: 'canal', category: 'cor', name: 'Separar canais (RGB / HSV)',
      description: 'Mostra um único canal de cor como imagem em tons de cinza.',
      params: [
        { id: 'ch', label: 'Canal', type: 'select', value: 'R', options: [
          { value: 'R', label: 'R — vermelho' }, { value: 'G', label: 'G — verde' }, { value: 'B', label: 'B — azul' },
          { value: 'H', label: 'H — matiz' }, { value: 'S', label: 'S — saturação' }, { value: 'V', label: 'V — valor (brilho)' },
        ] },
      ],
      theory: (p) => `
        <p>Uma imagem colorida é uma pilha de matrizes, uma por canal. Exibir um canal isolado mostra quanto daquela componente existe em cada pixel: claro = muito, escuro = pouco.</p>
        <p>No espaço <b>HSV</b> a cor é descrita por matiz (H), saturação (S) e brilho (V), o que facilita segmentar objetos pela cor.${p.ch === 'H' ? ' No OpenCV, H vai de 0 a 179 (graus ÷ 2), por isso o canal parece escuro.' : ''}</p>
        <p>Atenção: o OpenCV em Python lê imagens na ordem <b>BGR</b>, então o vermelho é o índice 2.</p>`,
      apply: (src, dst, p) => {
        const hsv = 'HSV'.includes(p.ch);
        let m = src;
        if (hsv) { m = new cv.Mat(); cv.cvtColor(src, m, cv.COLOR_RGB2HSV); }
        const ch = new cv.MatVector(); cv.split(m, ch);
        const idx = { R: 0, G: 1, B: 2, H: 0, S: 1, V: 2 }[p.ch];
        const c = ch.get(idx); c.copyTo(dst);
        c.delete(); ch.delete(); if (hsv) m.delete();
        if (p.ch === 'H') return 'O canal H usa a faixa 0–179, por isso aparece mais escuro.';
      },
      code: (p) => 'HSV'.includes(p.ch)
        ? [`img = cv2.split(cv2.cvtColor(cor(img), cv2.COLOR_BGR2HSV))[${{ H: 0, S: 1, V: 2 }[p.ch]}]  # canal ${p.ch}`]
        : [`img = cv2.split(cor(img))[${{ B: 0, G: 1, R: 2 }[p.ch]}]  # canal ${p.ch} (ordem BGR)`],
    },
    {
      id: 'sepia', category: 'cor', name: 'Sépia',
      description: 'Tom envelhecido obtido por uma transformação linear entre canais.',
      params: [
        { id: 'k', label: 'Intensidade', type: 'range', min: 0, max: 1, step: 0.05, value: 1 },
      ],
      theory: () => `
        <p>Cada canal de saída é uma combinação dos três canais de entrada, ou seja, uma <b>multiplicação de matriz 3×3</b> por pixel:</p>
        <p class="formula">R' = 0,393R + 0,769G + 0,189B<br>G' = 0,349R + 0,686G + 0,168B<br>B' = 0,272R + 0,534G + 0,131B</p>
        <p>A intensidade mistura o resultado com a imagem original.</p>`,
      apply: (src, dst, p) => {
        src.copyTo(dst);
        const d = dst.data; const k = p.k;
        for (let i = 0; i < d.length; i += 3) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const sr = Math.min(255, 0.393 * r + 0.769 * g + 0.189 * b);
          const sg = Math.min(255, 0.349 * r + 0.686 * g + 0.168 * b);
          const sb = Math.min(255, 0.272 * r + 0.534 * g + 0.131 * b);
          d[i] = r + k * (sr - r); d[i + 1] = g + k * (sg - g); d[i + 2] = b + k * (sb - b);
        }
      },
      code: (p) => [
        'kernel = np.array([[0.131, 0.534, 0.272],   # B\'',
        '                   [0.168, 0.686, 0.349],   # G\'',
        '                   [0.189, 0.769, 0.393]])  # R\' (ordem BGR)',
        'sepia = cv2.transform(cor(img), kernel)',
        `img = cv2.addWeighted(cor(img), ${fmt(1 - p.k)}, sepia, ${fmt(p.k)}, 0)`,
      ],
    },

    // ===== Limiarização =====
    {
      id: 'limiar', category: 'limiar', name: 'Limiarização simples',
      description: 'Separa a imagem em preto e branco por um valor de corte.',
      params: [
        { id: 't', label: 'Limiar (T)', type: 'range', min: 0, max: 255, step: 1, value: 127 },
        { id: 'inv', label: 'Inverter resultado', type: 'check', value: false },
      ],
      theory: (p) => `
        <p>A forma mais simples de <b>segmentação</b>: cada pixel é classificado como objeto ou fundo.</p>
        <p class="formula">g(x,y) = ${p.inv ? '0 se f(x,y) > T, senão 255' : '255 se f(x,y) > T, senão 0'} &nbsp;(T = ${p.t})</p>
        <p>Use o histograma para escolher T: um bom limiar costuma ficar no "vale" entre dois picos.</p>`,
      apply: (src, dst, p) => {
        const g = gray(src);
        cv.threshold(g, dst, p.t, 255, p.inv ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY);
        g.delete();
      },
      code: (p) => [`_, img = cv2.threshold(cinza(img), ${p.t}, 255, cv2.${p.inv ? 'THRESH_BINARY_INV' : 'THRESH_BINARY'})`],
    },
    {
      id: 'otsu', category: 'limiar', name: 'Limiarização de Otsu',
      description: 'Escolhe o limiar automaticamente a partir do histograma.',
      params: [
        { id: 'blur', label: 'Suavizar antes (gaussiano 5×5)', type: 'check', value: true },
        { id: 'inv', label: 'Inverter resultado', type: 'check', value: false },
      ],
      theory: () => `
        <p>O método de Otsu testa todos os limiares possíveis e escolhe o que <b>maximiza a variância entre as duas classes</b> (objeto e fundo), ou seja, o que melhor as separa.</p>
        <p>Funciona bem quando o histograma é <i>bimodal</i> (dois picos). Suavizar antes reduz o efeito do ruído.</p>`,
      apply: (src, dst, p) => {
        const g = gray(src);
        if (p.blur) cv.GaussianBlur(g, g, new cv.Size(5, 5), 0);
        const t = cv.threshold(g, dst, 0, 255, (p.inv ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) + cv.THRESH_OTSU);
        g.delete();
        return `Limiar escolhido pelo método de Otsu: T = ${Math.round(t)}`;
      },
      code: (p) => [
        'cinzento = cinza(img)',
        ...(p.blur ? ['cinzento = cv2.GaussianBlur(cinzento, (5, 5), 0)'] : []),
        `t, img = cv2.threshold(cinzento, 0, 255, cv2.${p.inv ? 'THRESH_BINARY_INV' : 'THRESH_BINARY'} + cv2.THRESH_OTSU)`,
        'print("Limiar de Otsu:", t)',
      ],
    },
    {
      id: 'adaptativa', category: 'limiar', name: 'Limiarização adaptativa',
      description: 'Um limiar diferente para cada região. Ideal para iluminação irregular.',
      params: [
        { id: 'method', label: 'Cálculo do limiar local', type: 'select', value: 'gauss', options: [
          { value: 'mean', label: 'Média da vizinhança' }, { value: 'gauss', label: 'Média gaussiana da vizinhança' },
        ] },
        { id: 'block', label: 'Tamanho da vizinhança', type: 'range', min: 3, max: 51, step: 2, value: 11, odd: true },
        { id: 'c', label: 'Constante C', type: 'range', min: -20, max: 20, step: 1, value: 2, hint: 'Subtraída da média local.' },
      ],
      theory: (p) => `
        <p>Em vez de um T global, cada pixel é comparado com a média da sua vizinhança de ${p.block}×${p.block}:</p>
        <p class="formula">T(x,y) = média<sub>local</sub>(x,y) − C</p>
        <p>Assim, sombras e reflexos não estragam a segmentação. É o método usado, por exemplo, para digitalizar documentos fotografados.</p>`,
      apply: (src, dst, p) => {
        const g = gray(src);
        cv.adaptiveThreshold(g, dst, 255, p.method === 'mean' ? cv.ADAPTIVE_THRESH_MEAN_C : cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, p.block, p.c);
        g.delete();
      },
      code: (p) => [`img = cv2.adaptiveThreshold(cinza(img), 255, cv2.${p.method === 'mean' ? 'ADAPTIVE_THRESH_MEAN_C' : 'ADAPTIVE_THRESH_GAUSSIAN_C'}, cv2.THRESH_BINARY, ${p.block}, ${p.c})`],
    },

    // ===== Bordas =====
    {
      id: 'sobel', category: 'bordas', name: 'Sobel',
      description: 'Aproxima a derivada da imagem para encontrar bordas.',
      params: [
        DIRECTION,
        { id: 'k', label: 'Tamanho do kernel', type: 'select', value: '3', options: [
          { value: '1', label: '1' }, { value: '3', label: '3' }, { value: '5', label: '5' }, { value: '7', label: '7' },
        ] },
      ],
      kernel: (p) => p.k === '3' ? [
        { title: 'Gx', m: [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]] },
        { title: 'Gy', m: [[-1, -2, -1], [0, 0, 0], [1, 2, 1]] },
      ] : null,
      theory: () => `
        <p>Uma borda é uma <b>mudança brusca de intensidade</b>, ou seja, onde a derivada é grande. O Sobel aproxima as derivadas em x e em y com dois kernels de convolução, dando peso maior à linha/coluna central (o que também suaviza um pouco o ruído).</p>
        <p class="formula">|G| ≈ |Gx| + |Gy|</p>
        <p>Os resultados podem ser negativos, por isso o cálculo usa 16 bits com sinal e depois o valor absoluto.</p>`,
      apply: (src, dst, p) => {
        const g = gray(src); const k = +p.k;
        const rx = new cv.Mat(), ry = new cv.Mat(), ax = new cv.Mat(), ay = new cv.Mat();
        cv.Sobel(g, rx, cv.CV_16S, 1, 0, k); cv.convertScaleAbs(rx, ax);
        cv.Sobel(g, ry, cv.CV_16S, 0, 1, k); cv.convertScaleAbs(ry, ay);
        combineDirections(ax, ay, p.dir, dst);
        [g, rx, ry, ax, ay].forEach((m) => m.delete());
      },
      code: (p) => [
        `gx = cv2.Sobel(cinza(img), cv2.CV_16S, 1, 0, ksize=${p.k})`,
        `gy = cv2.Sobel(cinza(img), cv2.CV_16S, 0, 1, ksize=${p.k})`,
        pyCombine(p.dir),
      ],
    },
    {
      id: 'prewitt', category: 'bordas', name: 'Prewitt',
      description: 'Como o Sobel, mas com pesos iguais em todas as linhas.',
      params: [DIRECTION],
      kernel: () => [
        { title: 'Gx', m: [[-1, 0, 1], [-1, 0, 1], [-1, 0, 1]] },
        { title: 'Gy', m: [[-1, -1, -1], [0, 0, 0], [1, 1, 1]] },
      ],
      theory: () => `
        <p>Operador de gradiente com kernels 3×3 de pesos uniformes. Compare com o Sobel: o Prewitt é um pouco mais sensível a ruído, porque não dá peso extra ao pixel central.</p>
        <p>O OpenCV não tem uma função pronta para o Prewitt; aplicamos os kernels com <code>filter2D</code>, a convolução genérica.</p>`,
      apply: (src, dst, p) => {
        const g = gray(src);
        const gx = convAbs(g, [-1, 0, 1, -1, 0, 1, -1, 0, 1], 3, 3);
        const gy = convAbs(g, [-1, -1, -1, 0, 0, 0, 1, 1, 1], 3, 3);
        combineDirections(gx, gy, p.dir, dst);
        [g, gx, gy].forEach((m) => m.delete());
      },
      code: (p) => [
        'kx = np.array([[-1, 0, 1], [-1, 0, 1], [-1, 0, 1]], np.float32)',
        'gx = cv2.filter2D(cinza(img), cv2.CV_16S, kx)',
        'gy = cv2.filter2D(cinza(img), cv2.CV_16S, kx.T)',
        pyCombine(p.dir),
      ],
    },
    {
      id: 'roberts', category: 'bordas', name: 'Roberts',
      description: 'Um dos primeiros detectores de borda: kernels 2×2 diagonais.',
      params: [DIRECTION],
      kernel: () => [
        { title: 'Gx (diagonal ↘)', m: [[1, 0], [0, -1]] },
        { title: 'Gy (diagonal ↙)', m: [[0, 1], [-1, 0]] },
      ],
      theory: () => `
        <p>Proposto por Lawrence Roberts em 1963. Calcula diferenças entre pixels <b>diagonais</b> com kernels de apenas 2×2. É rápido e localiza bem as bordas, mas é muito sensível a ruído.</p>
        <p>Aqui "horizontal" e "vertical" correspondem às duas diagonais.</p>`,
      apply: (src, dst, p) => {
        const g = gray(src);
        const gx = convAbs(g, [1, 0, 0, -1], 2, 2);
        const gy = convAbs(g, [0, 1, -1, 0], 2, 2);
        combineDirections(gx, gy, p.dir, dst);
        [g, gx, gy].forEach((m) => m.delete());
      },
      code: (p) => [
        'kx = np.array([[1, 0], [0, -1]], np.float32)',
        'ky = np.array([[0, 1], [-1, 0]], np.float32)',
        'gx = cv2.filter2D(cinza(img), cv2.CV_16S, kx)',
        'gy = cv2.filter2D(cinza(img), cv2.CV_16S, ky)',
        pyCombine(p.dir),
      ],
    },
    {
      id: 'laplaciano', category: 'bordas', name: 'Laplaciano',
      description: 'Segunda derivada: destaca bordas em todas as direções de uma vez.',
      params: [
        { id: 'k', label: 'Tamanho do kernel', type: 'select', value: '1', options: [
          { value: '1', label: '1 (kernel 3×3 básico)' }, { value: '3', label: '3' }, { value: '5', label: '5' },
        ] },
        { id: 'blur', label: 'Suavizar antes (gaussiano 3×3)', type: 'check', value: true, hint: 'A segunda derivada amplifica muito o ruído.' },
      ],
      kernel: (p) => p.k === '1' ? [{ title: 'Kernel laplaciano', m: [[0, 1, 0], [1, -4, 1], [0, 1, 0]] }] : null,
      theory: () => `
        <p>O laplaciano soma as segundas derivadas em x e y:</p>
        <p class="formula">∇²f = ∂²f/∂x² + ∂²f/∂y²</p>
        <p>É <b>isotrópico</b> (não depende da direção da borda) e marca as bordas como passagens por zero. Por ser muito sensível a ruído, costuma vir depois de um gaussiano; essa combinação é o <i>LoG</i> (Laplacian of Gaussian).</p>`,
      apply: (src, dst, p) => {
        const g = gray(src); const r = new cv.Mat();
        if (p.blur) cv.GaussianBlur(g, g, new cv.Size(3, 3), 0);
        cv.Laplacian(g, r, cv.CV_16S, +p.k);
        cv.convertScaleAbs(r, dst);
        g.delete(); r.delete();
      },
      code: (p) => [
        'cinzento = cinza(img)',
        ...(p.blur ? ['cinzento = cv2.GaussianBlur(cinzento, (3, 3), 0)'] : []),
        `img = cv2.convertScaleAbs(cv2.Laplacian(cinzento, cv2.CV_16S, ksize=${p.k}))`,
      ],
    },
    {
      id: 'canny', category: 'bordas', name: 'Canny',
      description: 'Detector de bordas em várias etapas: bordas finas e contínuas.',
      params: [
        { id: 't1', label: 'Limiar inferior', type: 'range', min: 0, max: 255, step: 1, value: 50 },
        { id: 't2', label: 'Limiar superior', type: 'range', min: 0, max: 255, step: 1, value: 150 },
        { id: 'blur', label: 'Suavizar antes (gaussiano 5×5)', type: 'check', value: true },
      ],
      warn: (p) => p.t1 > p.t2 ? 'O limiar inferior está maior que o superior. O OpenCV troca os dois, mas o normal é inferior < superior (proporção de 1:2 a 1:3).' : null,
      theory: (p) => `
        <p>Proposto por John Canny (1986), combina quatro etapas:</p>
        <p>1. Suavização gaussiana para reduzir ruído;<br>2. Gradiente (Sobel) com magnitude e direção;<br>3. <b>Supressão de não máximos</b>: afina as bordas para 1 pixel;<br>4. <b>Histerese</b>: gradientes acima de ${p.t2} são bordas fortes; entre ${p.t1} e ${p.t2} só viram borda se estiverem ligados a uma forte.</p>`,
      apply: (src, dst, p) => {
        const g = gray(src);
        if (p.blur) cv.GaussianBlur(g, g, new cv.Size(5, 5), 0);
        cv.Canny(g, dst, p.t1, p.t2);
        g.delete();
      },
      code: (p) => [
        'cinzento = cinza(img)',
        ...(p.blur ? ['cinzento = cv2.GaussianBlur(cinzento, (5, 5), 0)'] : []),
        `img = cv2.Canny(cinzento, ${p.t1}, ${p.t2})`,
      ],
    },

    // ===== Morfologia e segmentação =====
    {
      id: 'morfologia', category: 'segmentacao', name: 'Operações morfológicas',
      description: 'Erosão, dilatação e combinações, guiadas por um elemento estruturante.',
      params: [
        { id: 'op', label: 'Operação', type: 'select', value: 'open', options: [
          { value: 'erode', label: 'Erosão' }, { value: 'dilate', label: 'Dilatação' },
          { value: 'open', label: 'Abertura (erosão → dilatação)' }, { value: 'close', label: 'Fechamento (dilatação → erosão)' },
          { value: 'gradient', label: 'Gradiente morfológico' }, { value: 'tophat', label: 'Top-hat' }, { value: 'blackhat', label: 'Black-hat' },
        ] },
        { id: 'shape', label: 'Forma do elemento', type: 'select', value: 'rect', options: [
          { value: 'rect', label: 'Retângulo' }, { value: 'ellipse', label: 'Elipse' }, { value: 'cross', label: 'Cruz' },
        ] },
        { id: 'k', label: 'Tamanho do elemento', type: 'range', min: 1, max: 21, step: 1, value: 5 },
        { id: 'it', label: 'Iterações', type: 'range', min: 1, max: 5, step: 1, value: 1 },
      ],
      theory: () => `
        <p>A morfologia matemática analisa a <b>forma</b> dos objetos usando um pequeno padrão, o elemento estruturante.</p>
        <p><b>Erosão</b>: o pixel fica com o mínimo da vizinhança (objetos claros encolhem). <b>Dilatação</b>: fica com o máximo (objetos claros crescem).</p>
        <p><b>Abertura</b> remove pontinhos claros; <b>fechamento</b> preenche buracos escuros. O <b>gradiente</b> (dilatação − erosão) revela contornos.</p>
        <p>Dica: o efeito fica mais claro em imagens binárias. Aplique <i>Otsu</i>, clique em "Aplicar e continuar" e depois volte aqui.</p>`,
      apply: (src, dst, p) => {
        const ops = { erode: cv.MORPH_ERODE, dilate: cv.MORPH_DILATE, open: cv.MORPH_OPEN, close: cv.MORPH_CLOSE, gradient: cv.MORPH_GRADIENT, tophat: cv.MORPH_TOPHAT, blackhat: cv.MORPH_BLACKHAT };
        const shapes = { rect: cv.MORPH_RECT, ellipse: cv.MORPH_ELLIPSE, cross: cv.MORPH_CROSS };
        const el = cv.getStructuringElement(shapes[p.shape], new cv.Size(p.k, p.k));
        cv.morphologyEx(src, dst, ops[p.op], el, new cv.Point(-1, -1), p.it, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
        el.delete();
      },
      code: (p) => {
        const ops = { erode: 'MORPH_ERODE', dilate: 'MORPH_DILATE', open: 'MORPH_OPEN', close: 'MORPH_CLOSE', gradient: 'MORPH_GRADIENT', tophat: 'MORPH_TOPHAT', blackhat: 'MORPH_BLACKHAT' };
        const shapes = { rect: 'MORPH_RECT', ellipse: 'MORPH_ELLIPSE', cross: 'MORPH_CROSS' };
        return [
          `elemento = cv2.getStructuringElement(cv2.${shapes[p.shape]}, (${p.k}, ${p.k}))`,
          `img = cv2.morphologyEx(img, cv2.${ops[p.op]}, elemento, iterations=${p.it})`,
        ];
      },
    },
    {
      id: 'contornos', category: 'segmentacao', name: 'Contornos de objetos',
      description: 'Segmenta com Otsu e desenha o contorno de cada objeto encontrado.',
      params: [
        { id: 'inv', label: 'Objetos escuros sobre fundo claro', type: 'check', value: false },
        { id: 'minArea', label: 'Área mínima (pixels)', type: 'range', min: 0, max: 5000, step: 10, value: 100, hint: 'Ignora objetos pequenos (ruído).' },
        { id: 'th', label: 'Espessura da linha', type: 'range', min: 1, max: 6, step: 1, value: 2 },
      ],
      theory: () => `
        <p>Um <b>contorno</b> é a curva que une os pixels da fronteira de uma região. O processo:</p>
        <p>1. Binarizar a imagem (aqui, com Otsu);<br>2. <code>findContours</code> percorre as fronteiras (algoritmo de Suzuki, 1985);<br>3. Filtrar por área e desenhar.</p>
        <p>Com os contornos é possível contar objetos, medir área e perímetro e reconhecer formas, um passo fundamental da visão computacional.</p>`,
      apply: (src, dst, p) => {
        const g = gray(src); const bin = new cv.Mat();
        cv.GaussianBlur(g, g, new cv.Size(5, 5), 0);
        cv.threshold(g, bin, 0, 255, (p.inv ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) + cv.THRESH_OTSU);
        const contours = new cv.MatVector(); const hier = new cv.Mat();
        cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        src.copyTo(dst);
        let n = 0;
        for (let i = 0; i < contours.size(); i++) {
          const c = contours.get(i);
          if (cv.contourArea(c) >= p.minArea) {
            cv.drawContours(dst, contours, i, new cv.Scalar(255, 40, 40), p.th, cv.LINE_8);
            n++;
          }
          c.delete();
        }
        [g, bin, contours, hier].forEach((m) => m.delete());
        return `${n} objeto(s) com área ≥ ${p.minArea} px encontrado(s).`;
      },
      code: (p) => [
        'cinzento = cv2.GaussianBlur(cinza(img), (5, 5), 0)',
        `_, binaria = cv2.threshold(cinzento, 0, 255, cv2.${p.inv ? 'THRESH_BINARY_INV' : 'THRESH_BINARY'} + cv2.THRESH_OTSU)`,
        'contornos, _ = cv2.findContours(binaria, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)',
        `contornos = [c for c in contornos if cv2.contourArea(c) >= ${p.minArea}]`,
        'print(len(contornos), "objeto(s) encontrado(s)")',
        'img = cor(img).copy()',
        `cv2.drawContours(img, contornos, -1, (40, 40, 255), ${p.th})`,
      ],
    },

    // ===== Ruído =====
    {
      id: 'sal-pimenta', category: 'ruido', name: 'Ruído sal e pimenta',
      description: 'Adiciona pixels pretos e brancos aleatórios, para testar filtros.',
      params: [
        { id: 'd', label: 'Densidade', type: 'range', min: 0, max: 0.3, step: 0.01, value: 0.05, hint: 'Fração dos pixels afetados.' },
      ],
      theory: () => `
        <p>Simula falhas de transmissão ou de sensor: alguns pixels "estouram" para 0 (pimenta) ou 255 (sal). É o ruído <b>impulsivo</b>.</p>
        <p>Use-o para comparar filtros: a <i>mediana</i> o remove quase totalmente, enquanto a <i>média</i> e o <i>gaussiano</i> só o espalham.</p>`,
      apply: (src, dst, p) => {
        src.copyTo(dst);
        const d = dst.data; const rand = rng(42); const half = p.d / 2;
        for (let i = 0; i < d.length; i += 3) {
          const r = rand();
          if (r < half) d[i] = d[i + 1] = d[i + 2] = 0;
          else if (r > 1 - half) d[i] = d[i + 1] = d[i + 2] = 255;
        }
      },
      code: (p) => [
        'rng = np.random.default_rng(42)',
        'sorteio = rng.random(img.shape[:2])',
        'img = img.copy()',
        `img[sorteio < ${fmt(p.d / 2)}] = 0`,
        `img[sorteio > ${fmt(1 - p.d / 2)}] = 255`,
      ],
    },
    {
      id: 'ruido-gaussiano', category: 'ruido', name: 'Ruído gaussiano',
      description: 'Soma a cada pixel um valor aleatório com distribuição normal.',
      params: [
        { id: 's', label: 'Desvio padrão (σ)', type: 'range', min: 0, max: 80, step: 1, value: 20 },
      ],
      theory: (p) => `
        <p>Modela o ruído eletrônico do sensor, presente principalmente em fotos com pouca luz:</p>
        <p class="formula">g(x,y) = f(x,y) + n(x,y), &nbsp; n ~ N(0, ${p.s}²)</p>
        <p>Filtros lineares como o <i>gaussiano</i> funcionam bem contra ele; o <i>bilateral</i> reduz o ruído sem borrar as bordas.</p>`,
      apply: (src, dst, p) => {
        src.copyTo(dst);
        const d = dst.data; const rand = rng(7);
        for (let i = 0; i < d.length; i++) {
          const u = rand() || 1e-9, v = rand();
          const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * p.s; // Box–Muller
          d[i] = Math.max(0, Math.min(255, d[i] + n));
        }
      },
      code: (p) => [
        `ruido = np.random.default_rng(42).normal(0, ${p.s}, img.shape)`,
        'img = np.clip(img + ruido, 0, 255).astype(np.uint8)',
      ],
    },
  ];

  const PY_HEADER = [
    'import cv2',
    'import numpy as np',
    '',
    'def cinza(img):',
    '    return img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)',
    '',
    'def cor(img):',
    '    return img if img.ndim == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)',
    '',
    'img = cv2.imread("imagem.jpg")  # o OpenCV lê as cores na ordem BGR',
  ];
  const PY_FOOTER = ['', 'cv2.imwrite("resultado.png", img)'];

  window.AHHO = { CATEGORIES, FILTERS, PY_HEADER, PY_FOOTER, odd };
})();
