# AHHO Filter

Ferramenta web educacional para aprender **processamento digital de imagens** aplicando filtros do OpenCV em tempo real, direto no navegador.

É a reconstrução da ferramenta do TCC *"Explorando o Processamento de Imagens com OpenCV: uma ferramenta interativa para facilitar o aprendizado e aplicações práticas na web"* (Antonio Hajime Harada Orozimbo, Ciência da Computação, UENP, 2024).

## O que mudou em relação à versão do TCC

| Versão do TCC (2024) | Nova versão |
|---|---|
| Python + Flask + OpenCV no servidor | **OpenCV.js (WebAssembly)** no navegador: sem servidor e com hospedagem gratuita |
| Cada ajuste enviava a imagem ao servidor | Resultado **em tempo real** enquanto o slider se move |
| Mensagens de erro sem orientação (70% de discordância na avaliação) | Toda mensagem de erro diz **o que aconteceu e como resolver** |
| Um filtro por vez | **Pipeline**: encadeie filtros, desfaça passos e volte à original |
| Explicação curta no modal | Aba **"Como funciona"** com fórmula, kernel de convolução e dicas de experimento |
| — | **Código Python equivalente** de cada filtro e do pipeline inteiro, pronto para rodar |
| — | **Histograma** antes/depois e tempo de processamento de cada filtro |
| — | Comparação **deslizante** ou **lado a lado** |

As imagens nunca saem do computador do usuário.

## Filtros disponíveis

As categorias seguem Gonzalez & Woods, como no TCC.

- **Realce:** brilho e contraste, correção gama, equalização de histograma, CLAHE, nitidez (máscara de desfoque)
- **Suavização:** média, gaussiano, mediana, bilateral
- **Cor:** escala de cinza, negativo, separação de canais RGB/HSV, sépia
- **Limiarização:** simples, Otsu, adaptativa
- **Bordas:** Sobel, Prewitt, Roberts, Laplaciano, Canny
- **Morfologia e segmentação:** erosão, dilatação, abertura, fechamento, gradiente, top-hat, black-hat; contornos de objetos
- **Ruído (para experimentos):** sal e pimenta, gaussiano

## Como rodar

A página precisa ser servida por HTTP (abrir o `index.html` com duplo clique não funciona bem em todos os navegadores):

```bash
python -m http.server 8000
```

Depois, abra http://localhost:8000. Na primeira vez, o navegador baixa o OpenCV.js (cerca de 10 MB) de `cdn.jsdelivr.net`.

## Como publicar (GitHub Pages)

1. Crie um repositório no GitHub e envie esta pasta.
2. Em **Settings → Pages**, escolha a branch `main` e a pasta `/ (root)`.
3. O site fica disponível em `https://<seu-usuario>.github.io/<repositorio>/`.

## Estrutura

```
index.html        página e layout
css/style.css     estilos (tema claro/escuro automático, responsivo)
js/filters.js     catálogo de filtros: parâmetros, teoria, kernel, OpenCV.js e código Python
js/app.js         interface: carregamento, renderização, pipeline, histograma e erros
TCC/              versão original do TCC (2024), em Python + Flask
```

## Versão original do TCC

O código apresentado no TCC continua na pasta [`TCC/meu-projeto`](TCC/meu-projeto). Para rodar:

```bash
cd TCC/meu-projeto
pip install flask opencv-python numpy
python app.py
```

Depois, abra http://localhost:5000.

Para **adicionar um filtro**, basta incluir um objeto no array `FILTERS` em `js/filters.js` (o formato está descrito no topo do arquivo). A interface é montada automaticamente.

## Próximos passos (roteiro)

- Medir **aprendizagem**, não só usabilidade: pequenos desafios ("deixe a imagem igual a esta") com teste antes/depois. Foi a principal lacuna da avaliação do TCC.
- Modo professor: roteiros de atividade e compartilhamento de pipelines por link.
- Mais técnicas: domínio da frequência (FFT), K-means, Watershed, detecção de faces.
- Repetir o questionário de usabilidade com uma amostra maior.
