# YouTube Sentiment Monitor

Extensão para Chrome (Manifest V3) que monitora o sentimento do chat em transmissões ao vivo do YouTube em tempo real.

## Funcionalidades

- **Gauge de humor** — indicador visual do sentimento médio da janela atual (últimos 30s)
- **Linha do tempo** — gráfico com histórico do sentimento e taxa de chat durante a live
- **Mapa de emoções** — radar com 10 dimensões emocionais (Alegria, Amor, Surpresa, Raiva, Tristeza, Medo, Nojo, Tédio, Curiosidade, Confiança)
- **Palavras em alta** — termos mais frequentes no chat desde o início da sessão
- **Picos de engajamento** — momentos de atividade acima do dobro da média
- **Detecção de ironia** — identifica mensagens irônicas/sarcásticas pelo padrão `kkk` + conteúdo negativo, emojis de zombaria, e expressões sarcásticas em PT
- **Análise de VOD** — analisa o chat completo de uma live gravada sem precisar assistir ao replay
- **Histórico de sessões** — todas as lives monitoradas ficam salvas localmente (IndexedDB)
- **Exportação** — relatório HTML, JSON e CSV por sessão

## Estrutura do Projeto

```
youtube-sentiment/
├── manifest.json                  # Manifest V3
├── icons/                         # Ícones da extensão (16, 48, 128px)
├── content/
│   └── content-script.js          # MutationObserver no chat do YouTube + detecção de VOD
├── background/
│   └── service-worker.js          # Análise de sentimento, tick engine, gestão de sessões
├── sidepanel/
│   ├── panel.html                 # Interface do painel lateral
│   ├── panel.css                  # Estilos (dark theme)
│   └── panel.js                   # Lógica de UI, gráficos (Chart.js), tempo real
└── lib/
    ├── chart.min.js               # Chart.js v4 (vendorizado, sem build step)
    ├── sentiment-lexicon.json     # Léxico AFINN-165 EN + ~1.250 palavras PT + 150 emojis
    └── storage.js                 # Wrapper IndexedDB
```

## Instalação

1. Clone o repositório
2. Abra `chrome://extensions` no Chrome
3. Ative o **Modo do desenvolvedor** (canto superior direito)
4. Clique em **Carregar sem compactação** e selecione a pasta do projeto
5. Acesse uma live no YouTube e abra o painel lateral clicando no ícone da extensão

## Como funciona

### Análise de sentimento

Cada mensagem do chat é pontuada usando um léxico de palavras com scores de −5 a +5 (baseado no AFINN-165 para inglês + extensão em português com gírias de streams, vocabulário político e de infoprodutos).

O score final considera:
- **Peso por tipo**: super chats (×10), memberships (×5), membros (×2), mensagens normais (×1)
- **Caps factor**: texto em maiúsculas amplifica o score em 40%
- **Ironia**: score multiplicado por 0,18 quando detectado padrão irônico (dilui o negativo pois a pessoa está se divertindo)
- **Janela deslizante**: média ponderada dos últimos 30 segundos, recalculada a cada 5s

### Análise de VOD

Ao acessar uma gravação de live, a extensão detecta o token de replay no `ytInitialData` e oferece analisar o chat completo via a API interna do YouTube (`/youtubei/v1/live_chat/get_live_chat_replay`), sem precisar assistir ao vídeo. O resultado é salvo como sessão normal no histórico.

### Mapa de emoções

10 dimensões são avaliadas por correspondência de palavras-gatilho e emojis em cada mensagem da janela atual. O radar exibe a distribuição relativa normalizada pela emoção dominante.

## Tecnologias

- Chrome Extension Manifest V3
- Chart.js v4 (radar + line charts)
- IndexedDB para persistência local
- `chrome.storage.session` para estado em tempo real entre SW e painel
- `chrome.alarms` como backup de keep-alive (1 min)
- `setInterval` no service worker para o tick engine de 5s

## Privacidade

Nenhum dado é enviado para servidores externos. Todo o processamento e armazenamento é local.
