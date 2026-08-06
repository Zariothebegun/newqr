# VEF-3 CORE - Visual Encoding File Transfer

**Sistema de Transferência de Ficheiros via Vídeo Visual**

O VEF-3 CORE permite transferir **QUALQUER ficheiro** (MP3, PDF, Word, ZIP, JPG, PNG, EXE, APK, etc.) de um computador para um telemóvel usando apenas:
- Um ecrã (monitor, laptop, tablet)
- Uma câmara (iPhone, Android, webcam)

**Não precisa de internet, WiFi, Bluetooth, cabos, ou QR codes.**

![VEF-3 Demo](assets/demo.gif)

## 🎯 Como Funciona

```
COMPUTADOR (Emissor)          TELEMÓVEL (Receptor)
┌─────────────────────┐        ┌─────────────────────┐
│ 1. Lê ficheiro      │        │ 1. Abre site        │
│ 2. Divide em blocos │        │ 2. Liga câmara      │
│ 3. Aplica Fountain  │──VÍDEO──►│ 3. Lê frames        │
│    Codes (LT)       │  frames │ 4. Decodifica cores │
│ 4. Codifica em cores│ coloridos│ 5. Reconstrói       │
│ 5. Renderiza frames  │        │    ficheiro         │
└─────────────────────┘        └─────────────────────┘
```

## 🚀 Começar

### Pré-requisitos

- Python 3.8+
- ffmpeg (para gerar vídeos)
- Navegador moderno com suporte a getUserMedia (Chrome, Safari, Firefox)

### Instalação

```bash
# Clone o repositório
git clone https://github.com/Zariothebegun/newqr.git
cd newqr

# Crie ambiente virtual (opcional mas recomendado)
python3 -m venv venv
source venv/bin/activate  # Linux/Mac
# ou
venv\Scripts\activate  # Windows

# Instale dependências
pip install -r requirements.txt
```

### Deploy no Render

O servidor WSGI da aplicação está no módulo `wsgi.py` e expõe o objeto `app`.
Configure o serviço Render com:

- **Build Command:** `python -m pip install -r requirements.txt`
- **Start Command:** `gunicorn wsgi:app --bind 0.0.0.0:$PORT --workers 2 --threads 4 --timeout 120`
- **Health Check Path:** `/health`

O arquivo `render.yaml` contém a mesma configuração para novos serviços
criados como Blueprint. Se o serviço já existir no Render, altere o **Start
Command** nas configurações do serviço e faça um novo deploy; adicionar um
`render.yaml` não substitui automaticamente um comando salvo no painel. Não
use o placeholder `gunicorn your_application.wsgi`, pois esse módulo não
existe neste projeto.

### Gerar Vídeo de Transferência

```bash
# Transferir um ficheiro
python encoder/video_generator.py meu_ficheiro.pdf

# Com opções
python encoder/video_generator.py imagem.png -o output.mp4 --fps 60 --preview

# Gerar vídeo de calibração
python encoder/video_generator.py --calibration
```

### Enviar e receber no navegador

A aplicação web tem agora as duas páginas que faltavam:

- `GET /send/` — escolher/arrastar um ficheiro e mostrar os blocos coloridos no ecrã;
- `GET /receive/` — abrir a câmara do telemóvel, ler os blocos e descarregar o ficheiro.

O envio é local: o ficheiro é lido no navegador e nunca é carregado para o
servidor. O emissor começa a repetir os pacotes Fountain assim que escolhes o
ficheiro. Para usar:

1. Abra `/receive/` no telemóvel e clique em **Iniciar câmara**.
2. Abra `/send/` no computador e escolha o ficheiro.
3. Aumente o brilho, use fullscreen e aponte o telemóvel para o JAB Code.
4. Quando terminar, clique em **Descarregar ficheiro** no telemóvel.

O link partilhado abre o receiver; o conteúdo continua a passar apenas pela
luz do ecrã para a câmara.

O transporte visual usa a biblioteca JAB Code real. O wasm do encoder/decoder
está em `decoder/static/third-party/jabcode.wasm` (compilado do core MIT de
`jabcode/jabcode` com Zig), carregado por `decoder/static/third-party/jabcodeJSLib.min.js`.
O JAB fornece finder patterns, paleta, correção LDPC e leitura de perspetiva;
o VEF-3 coloca por cima o cabeçalho e o Fountain stream. O formato do pacote
está em `decoder/static/jab-transfer.js`. Cada pacote leva os índices dos
blocos Fountain que foram combinados por XOR, por isso os frames podem chegar
fora de ordem e alguns podem perder-se. Para reconstruir o wasm, ver
`decoder/static/third-party/README.md`.

## 📐 Especificações Técnicas

### O Frame Visual

Cada frame é criado pelo **JAB Code**: um símbolo primário com quatro
finder patterns e, quando necessário, símbolos secundários acoplados. A
biblioteca escolhe a geometria adequada ao tamanho do pacote, inclui a paleta
de cores no próprio código e aplica a correção LDPC do formato.

### Camada Fountain

O VEF-3 coloca um pacote Fountain dentro de cada JAB Code:

| Métrica | Valor |
|---------|-------|
| JAB symbols por frame | 1 primário |
| Cores JAB | 8 |
| Tamanho do frame | ajustado automaticamente até ~2877 B (limite do menu) |
| Compressão | gzip automático quando compensa (texto/PDF/código) |
| 30 fps (taxa nominal) | até ~86 KB/s |
| 60 fps (se o decoder acompanhar) | até ~170 KB/s |

O tamanho do frame é escolhido pelo sender ao testar o que o encoder JAB
realmente aguenta, e ficheiros compressíveis são gzip antes de codificar — um
documento de texto de 200 KB pode chegar a ~1 KB. A taxa real depende do tempo
que o JAB Code demora a ser gerado e lido pela câmara.

### Tempos de Transferência (estimativa)

| Ficheiro | Tamanho | @ 30 fps | @ 60 fps |
|----------|---------|----------|----------|
| Documento | 500 KB | ~7 seg | ~3.5 seg |
| Música MP3 | 1.9 MB | ~27 seg | ~14 seg |
| Foto JPG | 5 MB | ~71 seg | ~36 seg |
| Vídeo MP4 | 10 MB | ~2.3 min | ~1.2 min |

## 🔧 Estrutura do Projeto

```
newqr/
├── core/                    # Módulos core partilhados
│   ├── __init__.py
│   ├── color_codec.py       # Codificação de bytes para cores
│   ├── fountain.py          # Fountain Codes (LT codes)
│   ├── frame.py             # Renderização 800×600 dos frames
│   ├── tile_codec.py        # 16 símbolos × 4 cores
│   └── protocol.py          # Formato comum Python/JavaScript
├── encoder/                 # Encoder (computador)
│   ├── __init__.py
│   └── video_generator.py   # Gerador de vídeos
├── decoder/                 # Receiver web e protocolo JS
│   ├── index.html           # Página para ler com a câmara
│   └── static/              # Protocolo, Fountain e receiver JavaScript
├── send/                    # Página para escolher e emitir ficheiros
│   └── index.html
├── assets/                  # Assets e demos
│   └── demo.gif
├── README.md
└── LICENSE
```

## 📋 Limitações

### ✅ O que funciona bem:
- Quarto com luz estável (artificial)
- Ecrã com brilho 80-100%
- Distância 20-40 cm
- Telemóvel parado (ou com suporte)

### ❌ O que NÃO funciona:
- Luz solar direta no ecrã
- Iluminação a mudar constantemente
- Telemóvel a mexer (motion blur)
- Brilho do ecrã < 50%
- Distância > 60 cm
- Ficheiros > 100 MB

## 💡 Dicas para Melhor Resultados

1. **Use um suporte** para o telemóvel (tripé, caixa, ou algo estável)
2. **Brilho máximo** no ecrã do computador
3. **Feche cortinas/janelas** se houver sol
4. **Desligue modo economia** de bateria no telemóvel
5. **Mantenha distância** de 25-35 cm
6. **Não mexa** no telemóvel durante a leitura

## 🛠️ Desenvolvimento

### Testar o Codec de Cores
```bash
python core/color_codec.py
```

### Testar Fountain Codes
```bash
python core/fountain.py
```

### Testar Renderização de Frames
```bash
python core/frame.py
```

## 📄 Licença

MIT License - Veja LICENSE para detalhes.

## 🙏 Créditos

Baseado em:
- Fountain Codes (Luby Transform Codes)
- Correção de perspetiva (Homography)
- Decodificação de cor (K-means / thresholding)

---

**Nota:** Este é um protótipo. Funciona em condições controladas mas não é "plug and play". A ideia é boa, a matemática é sólida, a execução precisa de iteração. **Nota do auditor: 7/10**
