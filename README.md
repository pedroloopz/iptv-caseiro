# IPTV caseiro

Servidor IPTV feito do zero, sem dependências (só **Node 20+** e **ffmpeg**):

- 📺 **Seus vídeos viram canais ao vivo** que seguem o relógio, como TV de verdade, com guia de programação automático.
- 🎓 **Modo estudo de japonês**: furigana, palavras tocáveis com significado, legenda dupla, repetir fala a fala e cartões para o Anki.
- 💬 **Legendas selecionáveis** (japonês, português…) no mesmo canal, e **legenda automática em japonês com furigana** para vídeos sem legenda.
- 📶 **Várias qualidades** (1080p/720p/480p/360p) com troca automática conforme a internet, e **codificação pela placa de vídeo**.
- 🌐 **Canais públicos** (Brasil, Portugal, Japão e Alemanha) do [iptv-org](https://github.com/iptv-org/iptv) e do [Free-TV](https://github.com/Free-TV/IPTV), atualizados a cada 6 h, retestados a cada 15 min e com **troca automática para o link reserva**.
- 🎬 **Filmes e séries sob demanda**, com capa e sinopse (TMDB) e "continuar de onde parou".
- 📱 **API Xtream Codes**: TiviMate, IPTV Smarters e XCIPTV entram só com servidor + usuário + senha.
- ⚙️ **Painel web** para favoritos, numeração, canais ocultos, usuários e ajustes, aplicados sem reiniciar.
- 🔒 **Um usuário por pessoa/aparelho**, limite de tentativas, HTTPS opcional.
- 🐳 **Docker**, verificação de saúde e testes automáticos no GitHub Actions.

> Retransmitir canais pagos sem autorização é ilegal no Brasil (Lei 9.610/98). As listas
> públicas trazem links de todo tipo; os filtros de `fontes.json` (`excluirIpSolto`,
> `excluirHosts`) ajudam a ficar só com fontes oficiais.

## Sem computador: servidor grátis na Oracle Cloud, tudo pelo celular

O IPTV precisa rodar 24 h em alguma máquina. Sem computador, a opção grátis é uma máquina
virtual da Oracle Cloud (plano *Always Free*). Tudo abaixo se faz no navegador do celular.
Os nomes dos botões podem mudar um pouco; o site também tem a opção de idioma português.

**1. Criar a conta** (uns 10 min)
1. Abra [signup.cloud.oracle.com](https://signup.cloud.oracle.com) e preencha país, nome e e-mail.
2. **Região inicial (Home Region)** — não dá para trocar depois, e o plano grátis só vale nela:
   - **Brazil East (São Paulo)**: menor atraso no Brasil;
   - **Germany Central (Frankfurt)**: os canais alemães que só tocam na Alemanha passam a abrir (veja o passo 6).
3. Cartão de crédito: só para verificação, não é cobrado no plano grátis; cartão pré-pago ou
   virtual costuma ser recusado ([documentação da Oracle](https://docs.cloud.oracle.com/iaas/Content/GSG/Tasks/signingup_topic-Sign_Up_for_Free_Oracle_Cloud_Promotion.htm)).

**2. Abrir o terminal da Oracle e criar a chave de acesso**
1. No painel da Oracle, toque no ícone **>_** (Cloud Shell), no alto da tela.
2. Cole e confirme (cria a chave e mostra a parte pública):
   ```bash
   ssh-keygen -t rsa -b 4096 -N "" -f ~/.ssh/id_rsa && cat ~/.ssh/id_rsa.pub
   ```
3. Copie a linha que começa com `ssh-rsa` (o Cloud Shell roda em modo FIPS e recusa chaves ed25519).

**3. Criar a máquina virtual**
1. Menu **☰ → Compute → Instances → Create instance**.
2. **Name:** `iptv`.
3. **Image:** *Change image* → **Canonical Ubuntu** → 24.04.
4. **Shape:** *Change shape* → **Ampere** → **VM.Standard.A1.Flex**, com **2 OCPU e 12 GB** (aparece o selo *Always Free-eligible*).
   O limite grátis teria caído de 4 para 2 OCPU em 06/2026, segundo [relatos](https://tilnote.io/pages/6a5abd08760649367e9e43ad); confira na tela.
5. **Networking:** deixe criar uma rede nova, com **Assign a public IPv4 address** ligado.
6. **Add SSH keys:** *Paste public keys* → cole a linha `ssh-rsa…` do passo 2.
7. **Create**. Se aparecer *Out of capacity*, tente outro *Availability domain* ou mais tarde.
8. Quando ficar verde (**Running**), copie o **Public IP address**.

**4. Liberar a porta 8080 na rede da Oracle**
1. Na página da máquina: **Primary VNIC → Subnet → Security Lists → Default Security List**.
2. **Add Ingress Rules:** Source CIDR `0.0.0.0/0` · IP Protocol **TCP** · Destination Port Range `8080` → **Add**.

**5. Instalar o IPTV** (5 a 10 min)
1. No Cloud Shell: `ssh ubuntu@IP_PUBLICO` (troque pelo IP) e responda `yes`.
2. Cole:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/pedroloopz/iptv-caseiro/main/instalar.sh | bash
   ```
3. No final aparecem o endereço do painel, o **usuário `admin`** e a **senha**: anote.

**6. Usar**
1. No celular: `http://IP_PUBLICO:8080/admin` → entre com admin e a senha → **Usuários → + Novo usuário** (ex.: `tv-sala`) → **Salvar**.
2. No IPTV Smarters Pro: **Login with Xtream Codes API** → URL `http://IP_PUBLICO:8080`, usuário e senha criados.
3. Servidor em Frankfurt? Em **Ajustes** (config.json), troque `"canaisPeloServidor"` para `"todos"`:
   a imagem dos canais passa pelo servidor alemão e os canais que só tocam na Alemanha (ARD, ZDF,
   Pluto TV alemã, como Nick e SpongeBob) abrem no Brasil. Gasta tráfego do servidor: o plano grátis
   inclui até [10 TB por mês de saída](https://cloud.oracle.com/free) (um canal em 720p usa
   em torno de 1 GB por hora). As emissoras limitam esses canais à Alemanha nos termos de uso delas.

**Atualizar no futuro:** Cloud Shell → `ssh ubuntu@IP_PUBLICO` → o mesmo comando do passo 5.
Seus canais, usuários e configurações ficam em `~/iptv-dados` e não são apagados.

## Começar (com computador)

```bash
# Ubuntu/Debian
sudo apt install ffmpeg nodejs fonts-noto-cjk
# macOS
brew install ffmpeg node
# Windows
winget install Gyan.FFmpeg OpenJS.NodeJS.LTS
```

```bash
git clone https://github.com/pedroloopz/iptv-caseiro.git
cd iptv-caseiro
node server.js
```

- TV no navegador: `http://localhost:8080`
- Painel: `http://localhost:8080/admin`
- Na primeira vez, o servidor baixa as listas públicas sozinho (leva alguns minutos testando os links).

Sem `usuarios.json` o acesso é **livre**, inclusive o painel. Crie um usuário administrador
logo no painel (**Usuários → + Novo usuário → Salvar**) ou copie `usuarios.exemplo.json`
para `usuarios.json` e troque as senhas.

## Como funciona

```
channels.json ──► transmissão sob demanda ──► ffmpeg (1 processo por vídeo da programação)
                    │  o servidor monta as playlists HLS: qualidades, legendas WebVTT, emendas
                    ▼
fontes.json ──► atualizar (6 h) ──► dados/externos.json ──► verificação (15 min) + troca de link
biblioteca/ ──► filmes e séries ──► /vod, API Xtream, player web
                    │
                    ├─ /                → player web (TV, Filmes, Séries)
                    ├─ /admin           → painel
                    ├─ /playlist.m3u    → playlist para VLC, TiviMate, Kodi…
                    ├─ /epg.xml         → guia de programação (XMLTV)
                    ├─ /player_api.php  → API Xtream Codes
                    └─ /saude           → verificação de saúde (sem senha)
```

| Pasta/arquivo | O que é |
|---|---|
| `channels.json` | seus canais |
| `fontes.json` | listas públicas, filtros e guias externos |
| `config.json` | qualidade, placa de vídeo, TMDB, HTTPS… |
| `usuarios.json` | usuários e senhas (não vai para o git) |
| `preferencias.json` | favoritos, ocultos e números (o painel grava) |
| `midia/` | vídeos dos seus canais |
| `biblioteca/filmes/`, `biblioteca/series/` | filmes e séries sob demanda |
| `dados/` | arquivos gerados: lista pública, guias, cache de legendas e do TMDB |

Mudanças nesses arquivos (à mão ou pelo painel) valem na hora, sem reiniciar.

## Seus canais (`channels.json`)

| `tipo` | `origem` | Uso |
|---|---|---|
| `teste` | — | barras coloridas + bipe |
| `arquivo` | um vídeo (`midia/filme.mp4`) | um vídeo em loop |
| `pasta` | uma pasta (`midia/minha-serie`) | vários vídeos em ordem (subpastas incluídas) |
| `url` | `http(s)`, `rtmp`, `rtsp`, `.m3u8` | câmera IP, live, outro stream |

Campos opcionais:

| Campo | Exemplo | O que faz |
|---|---|---|
| `grupo`, `logo` | `"Japonês"`, URL | organização na lista |
| `idiomaLegenda` | `"ja"` | legenda que já começa ligada (as outras ficam no menu) |
| `legenda` | `"midia/filme.pt.srt"` | legenda de um `arquivo` com nome diferente do vídeo |
| `legendaGravada` | `"pt"` | grava essa legenda na imagem (para TVs/apps sem suporte a legenda) |
| `qualidades` | `["1080p", "480p"]` | substitui o `config.json` só neste canal |
| `bitrate` | `"4000k"` | taxa do vídeo (com uma qualidade só) |
| `copiar` | `true` | não recodifica (fonte já em H.264/AAC, sem legenda gravada): quase zero CPU |
| `recursivo` | `false` | numa `pasta`, ignora subpastas |
| `programacao` | `[{"inicio":"20:00","fim":"22:00","titulo":"…"}]` | guia manual (para `teste` e `url`) |
| `epgId` | `"Record.br"` | id do canal num guia externo, se for diferente |

### Programação pelo relógio

Canais `arquivo` e `pasta` "passam" sem parar desde 01/01/2026, em ciclo. Ao abrir o canal,
você cai no ponto exato do que estaria passando agora, e o guia (`/epg.xml`) mostra o que vem
depois, com os nomes dos arquivos. Colocar ou tirar vídeos da pasta muda a grade a partir dali.

O canal só usa CPU enquanto alguém assiste: desliga 60 s depois que o último espectador sai.

### Legendas

```
midia/minha-serie/
├── Episódio 01.mkv          ← legendas embutidas no .mkv também são detectadas
├── Episódio 01.ja.srt
├── Episódio 01.pt.srt       ← .srt, .ass, .ssa ou .vtt; sem idioma no nome = idiomaLegendaPadrao
├── Episódio 02.mkv
└── ...
```

- No player web, escolha em **Legenda**; a escolha vale para todos os canais e filmes.
- Nos apps (TiviMate, VLC), use o menu de legendas do próprio app.
- Legenda com acentos quebrados (`Ã§`) é convertida sozinha (Windows-1252 → UTF-8).
- Legenda em imagem (PGS/DVD, de Blu-ray) não é suportada; use uma .srt.

Para treinar japonês, prefira legenda em japonês, não em português: num estudo, legenda no
idioma estrangeiro ajudou a entender a fala e legenda na língua materna atrapalhou
([Mitterer & McQueen, 2009](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0007785)).

### Legenda automática em japonês

Para vídeos com **áudio em japonês** sem legenda japonesa, o servidor transcreve o áudio com o
[Whisper](https://github.com/openai/whisper) (no seu computador, de graça) e cria duas faixas:

- **日本語 · automática**: 今日は天気がいいですね。
- **日本語 (ふりがな) · automática**: 今日（きょう）は天気（てんき）がいいですね。

A leitura da furigana vem da análise do MeCab, que considera o contexto (今日は = きょうは, não こんにちは).

**Instalação (uma vez):**

```bash
pip install faster-whisper fugashi unidic-lite
```

No `config.json` (ou painel → Ajustes):

```json
"transcricao": { "ativo": true, "modelo": "small", "dispositivo": "auto", "python": "python3", "furigana": true }
```

- Funciona nos canais `arquivo`/`pasta` e na biblioteca. Um vídeo por vez, em segundo plano; vídeos novos entram sozinhos a cada 30 min (ou painel → **Gerar legendas japonesas agora**).
- O áudio é conferido antes: faixa marcada como japonesa é transcrita direto; sem marca, o Whisper detecta o idioma e pula se não for japonês. Em arquivos com dois áudios (dublado + original), usa a faixa japonesa.
- Legenda feita por você (`Ep01.ja.srt`) sempre tem prioridade; a automática fica em `dados/transcricoes/` e a pasta dos seus vídeos não é alterada.
- Nos filmes e séries a legenda aparece na hora; num canal ao vivo, na próxima vez que ele ligar.
- **Modelo:** maior = mais preciso e mais lento ([tabela oficial](https://github.com/openai/whisper#available-models-and-languages)). Sem placa de vídeo, comece com `small`; com placa NVIDIA, `large-v3`, com `"dispositivo": "cuda"` (precisa das bibliotecas CUDA indicadas no [faster-whisper](https://github.com/SYSTRAN/faster-whisper#gpu)). Na primeira vez, o modelo é baixado da internet.
- Transcrição automática erra, principalmente com música alta, falas sobrepostas e nomes próprios.
- Alternativa sem Python para a transcrição: [whisper.cpp](https://github.com/ggml-org/whisper.cpp), com `"motor": "whisper.cpp"`, `"whisperCpp": "whisper-cli"` e `"modelo": "/caminho/ggml-small.bin"` (a furigana continua precisando do Python com fugashi).
- Windows: use `"python": "python"` (ou `py`).

## Modo estudo (japonês)

No player web (navegador do celular, da TV ou do computador), toque em **🎓 Estudo** com um
filme, episódio ou canal que tenha legenda japonesa (sua ou automática):

- **Fala com furigana** sobre o vídeo, e as **palavras são tocáveis**: leitura, forma de dicionário
  (行き → 行く), classe gramatical e significado (dicionário JMdict, em inglês), mais atalhos para o
  Jisho e o Google Tradutor.
- **2ª legenda** (ex.: português) logo abaixo, pareada com a fala japonesa — só em filmes e séries,
  porque ao vivo o player carrega uma faixa de legenda por vez.
- **⏮ Anterior · 🔁 Repetir · ⏭ Próxima** fala (teclas A, S, D), **pausar a cada fala** e velocidade 0,5×/0,75×.
- **⭐ Salvar frase/palavra** → **📚 Cartões**, que ficam no servidor (cada usuário tem os seus, em
  qualquer aparelho) e são exportados para o **Anki** (no Anki: **Arquivo → Importar**), com a furigana.

Revisar com repetição espaçada melhora a memorização ([Cepeda et al., 2006](https://doi.org/10.1037/0033-2909.132.3.354)).

Precisa do MeCab no servidor (`pip install fugashi unidic-lite`; o `instalar.sh` já instala).
O dicionário (~palavras comuns do [JMdict](https://github.com/scriptin/jmdict-simplified)) é baixado
sozinho na primeira vez; `"estudo": { "dicionario": false }` desliga. Os apps de TV (Smarters,
TiviMate) não têm esses recursos: o modo estudo é do player web.

## Qualidade e placa de vídeo (`config.json`)

| Campo | Padrão | Opções |
|---|---|---|
| `qualidades` | `["720p"]` | `1080p`, `720p`, `480p`, `360p`; várias = o player troca conforme a internet |
| `aceleracao` | `cpu` | `nvenc` (NVIDIA), `qsv` (Intel Quick Sync), `vaapi` (Intel/AMD no Linux), `videotoolbox` (Mac) |
| `dispositivoVaapi` | `/dev/dri/renderD128` | placa usada pelo `vaapi` |
| `segundosSegmento` / `janelaSegmentos` | `4` / `6` | latência × estabilidade |
| `ociosoSegundos` | `60` | desliga o canal sem espectadores |

Cada qualidade a mais custa mais processamento. Com `cpu`, uma qualidade 720p ocupa mais ou
menos um núcleo; com placa de vídeo, várias qualidades em vários canais ficam leves. Para
conferir se o seu ffmpeg tem o codificador: `ffmpeg -encoders | grep -E "nvenc|qsv|vaapi|videotoolbox"`.

## Canais públicos (`fontes.json`)

O servidor baixa as listas, testa cada link e guarda **todos** os que responderam para cada
canal. Entre as atualizações, retesta tudo a cada `verificarACadaMinutos` (`config.json`). Se o
link em uso cai, passa para o reserva sozinho, inclusive no meio de uma requisição.

| Campo | Padrão | O que faz |
|---|---|---|
| `listas` | iptv-org e Free-TV: Brasil, Portugal, Japão e Alemanha | URLs `.m3u`, ou `{ "url": "…", "grupo": "Alemanha", "categorias": ["Movies", "Series"] }`: `grupo` junta os canais da lista num grupo; `categorias` mantém só essas categorias do iptv-org |
| `atualizarACadaHoras` | `6` | intervalo entre downloads |
| `excluirGrupos` | `[]` | ex.: `["Shop", "Religious"]` |
| `excluirNaoVinteQuatroHoras` | `false` | remove canais `[Not 24/7]` |
| `excluirIpSolto` | `false` | `true` ignora links em IP cru (quase sempre retransmissão não autorizada) |
| `excluirHosts` | 4 domínios | domínios a ignorar |
| `testarStreams`, `timeoutTesteMs`, `simultaneos` | `true`, `8000`, `20` | teste dos links |
| `epgExterno` | `[]` | guias XMLTV (`.xml` ou `.xml.gz`) |

- Mais listas = mais links reserva. O mesmo canal em listas diferentes (mesmo `tvg-id`), ou em
  qualidades diferentes (`@SD`/`@HD`), vira reserva automaticamente.
- Links do YouTube são ignorados (players de IPTV não tocam).
- Muitos canais alemães (ARD, ZDF, arte…) e japoneses só tocam dentro do próprio país (marcados `[Geo-blocked]`/Ⓖ nas listas); fora de lá aparecem mas não abrem.
- Se `iptv-org.github.io` estiver bloqueado na sua rede, o mesmo arquivo é baixado de `raw.githubusercontent.com`.
- Forçar agora: painel → **Atualizar lista pública agora**, ou `node atualizar.js`.

Na playlist, os canais públicos apontam para `/canal/<id>.m3u8` no seu servidor, que redireciona
para o link no ar (a imagem não passa pela sua máquina). Fontes que exigem User-Agent/Referer,
e o player web, passam pelo proxy do servidor. `"linksDiretos": true` no `config.json` põe o
link original na playlist, mas aí não há troca automática.

`"canaisPeloServidor"` decide quando a imagem dos canais públicos passa pelo servidor: `"geo"` (padrão)
só os marcados como bloqueados por país, `"todos"` todos (útil com o servidor em outro país, como
Frankfurt), `"nenhum"` nenhum. Muitos canais não vêm marcados nas listas; com o servidor fora do
Brasil, prefira `"todos"`.

## Guia de programação

`/epg.xml` junta tudo, já com os ids dos seus canais:

1. a grade dos canais `arquivo`/`pasta` (automática) e a `programacao` manual;
2. os guias de `epgExterno` (filtrados para os seus canais; o casamento é pelo `tvg-id` das listas, ou pelo `epgId`);
3. opcional: o **coletor oficial do iptv-org** ([iptv-org/epg](https://github.com/iptv-org/epg)),
   que monta o guia só dos seus canais a partir dos sites mapeados pelo projeto:

   ```json
   "epgIptvOrg": { "ativo": true, "dias": 2, "conexoes": 5 }
   ```

   Precisa de `git` e `npm`. Na primeira vez baixa o projeto em `dados/epg-grabber` (~430 MB)
   e a coleta pode levar vários minutos; roda a cada atualização da lista.

## Filmes e séries

```
biblioteca/
├── filmes/
│   ├── Meu Filme (2019).mkv
│   ├── Meu Filme (2019).pt.srt
│   └── Anime/                       ← subpasta = categoria
│       └── Outro.Filme.2005.1080p.mp4
└── series/
    └── Nome da Série/
        ├── S01E01.mkv               ← S01E01, 1x01, "Temporada 1/Episódio 01" ou só o número
        ├── S01E01.ja.srt
        └── ...
```

- Aparecem nas abas **Filmes** e **Séries** do player web (com "continuar de onde parou") e nos apps Xtream.
- Capas, sinopses e notas: crie uma chave grátis em [themoviedb.org](https://www.themoviedb.org/settings/api)
  e cole em `"tmdbApiKey"` no `config.json`.
- O navegador toca bem `.mp4` (H.264); `.mkv` com HEVC ou `.avi` tocam pelo VLC ou pelos apps de TV.
- A biblioteca é relida a cada 10 min (ou painel → **Reler biblioteca**).

## Assistir na TV e no celular

Descubra o IP do computador: `ip a` (Linux), `ipconfig` (Windows) ou `ipconfig getifaddr en0` (macOS).

**Apps com Xtream Codes (recomendado, mostra filmes e séries):** TiviMate, IPTV Smarters, XCIPTV
1. Adicionar playlist → **Xtream Codes**
2. Servidor: `http://SEU_IP:8080`
3. Usuário e senha: os de `usuarios.json`
4. No TiviMate, em formato de stream, escolha **HLS (m3u8)**

**Apps com M3U:** VLC (**Mídia → Abrir fluxo de rede**), Kodi (PVR IPTV Simple Client)
- Playlist: `http://SEU_IP:8080/playlist.m3u?token=SUA_SENHA`
- Guia (se o app pedir separado): `http://SEU_IP:8080/epg.xml?token=SUA_SENHA`

## Usuários e segurança

- Cada pessoa ou aparelho com a sua senha (mínimo de 8 caracteres). A senha também é o token dos links.
- **Desativar** um usuário no painel corta o acesso na hora, sem mudar a senha dos outros.
- 10 senhas erradas em 10 min bloqueiam aquele IP por 15 min.
- `IPTV_TOKEN=senha node server.js` cria um administrador temporário (útil no primeiro acesso).

**HTTPS:** `config.json` → `"https": { "cert": "cert.pem", "key": "key.pem" }`, ou as variáveis
`IPTV_CERT`/`IPTV_KEY`. Para domínio próprio, o mais simples é o Caddy na frente (certificado automático):

```bash
caddy reverse-proxy --from tv.seudominio.com.br --to :8080
```

**Fora de casa:** [Tailscale](https://tailscale.com/download) no servidor e no celular, usando
o IP `100.x.x.x`, sem abrir porta no roteador. Se for abrir porta, só com usuários criados + HTTPS.

## Docker (para deixar ligado 24 h)

Bom para um mini PC ou Raspberry Pi 4/5 sempre ligado:

```bash
cd iptv-caseiro
docker compose up -d --build
docker compose logs -f
```

- Seus arquivos ficam em `./dados-docker` (`channels.json`, `usuarios.json`…). Na primeira
  execução, os exemplos são copiados para lá.
- Monte suas pastas de vídeo e biblioteca descomentando as linhas `volumes` do `docker-compose.yml`.
- Placa de vídeo Intel/AMD: descomente `devices: /dev/dri` e use `"aceleracao": "vaapi"`.
- Legenda automática em japonês: mude `TRANSCRICAO: "1"` no `docker-compose.yml` e rode `docker compose up -d --build` (os modelos ficam em `dados-docker/modelos`).
- O Docker vigia `/saude` e reinicia o container se travar (`restart: unless-stopped`).

Sem Docker, no Linux, um serviço do systemd faz o mesmo:

```ini
# /etc/systemd/system/iptv.service
[Unit]
Description=IPTV caseiro
After=network-online.target

[Service]
WorkingDirectory=/caminho/para/iptv
ExecStart=/usr/bin/node server.js
Restart=always
User=SEU_USUARIO

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now iptv
```

## Testes

```bash
cd iptv-caseiro
npm test
```

São testes de unidade e de integração. Os de integração sobem o servidor de verdade com vídeos
gerados pelo ffmpeg, uma fonte externa falsa (link morto + reserva), biblioteca e usuários. Eles
rodam sozinhos no GitHub Actions (`.github/workflows/testes.yml`) a cada mudança enviada.

## Estrutura do código

| Arquivo | Responsabilidade |
|---|---|
| `server.js` | rotas HTTP, senhas, tarefas periódicas |
| `lib/transmissao.js` | canais ao vivo: ffmpeg por vídeo, playlists HLS montadas pelo servidor |
| `lib/agenda.js` | programação pelo relógio |
| `lib/legendas.js` | descoberta, conversão para WebVTT e pedaços de legenda |
| `lib/codificador.js` | qualidades e codificação por hardware |
| `lib/atualizar.js` | download, teste e agrupamento das listas públicas |
| `lib/externos.js` | verificação contínua, troca de link e proxy assinado |
| `lib/epg.js` | guia XMLTV e coletor do iptv-org |
| `lib/biblioteca.js` | filmes, séries e TMDB |
| `lib/xtream.js` | API Xtream Codes |
| `lib/estudo.js`, `scripts/estudo.py` | modo estudo: análise das falas, dicionário, cartões e Anki |
| `instalar.sh` | instalação e atualização num servidor Ubuntu (Oracle Cloud etc.) |
| `lib/transcricao.js`, `scripts/*.py` | legenda automática em japonês (Whisper) e furigana (MeCab) |
| `lib/auth.js` | usuários e limite de tentativas |
| `lib/canais.js` | lista única de canais com favoritos e numeração |
| `lib/config.js`, `lib/midia.js` | arquivos de configuração; ffprobe com cache |
