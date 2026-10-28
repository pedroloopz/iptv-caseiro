// Sobe o servidor de verdade numa raiz temporária, com vídeos gerados pelo ffmpeg,
// uma fonte externa falsa (um link morto e um vivo) e a biblioteca de filmes/séries.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-integracao-'));
const PORTA = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORTA}`;
const ADMIN = 'senha-admin-123';
const SALA = 'senha-da-sala-1';
let servidor, fonte, portaFonte, log = '';

function video(arquivo, segundos, freq = 440, idiomaAudio) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}`, '-t', String(segundos), '-c:v', 'libx264', '-preset', 'ultrafast',
    '-c:a', 'aac', ...(idiomaAudio ? ['-metadata:s:a:0', `language=${idiomaAudio}`] : []), arquivo]);
}

// "python" de mentira: faz o papel do Whisper e do MeCab sem baixar modelos
const PYTHON_FALSO = `#!/usr/bin/env node
const fs = require('fs');
const [script, ...a] = process.argv.slice(2);
if (script.endsWith('transcrever.py')) {
  if (a.includes('--detectar')) { console.log(JSON.stringify({ idioma: 'pt' })); process.exit(3); }
  fs.writeFileSync(a[1], '1\\n00:00:00,500 --> 00:00:02,000\\n今日は\\n');
  console.log('{"falas":1}');
} else if (script.endsWith('furigana.py')) {
  fs.writeFileSync(a[1], '1\\n00:00:00,500 --> 00:00:02,000\\n今日（きょう）は\\n');
}`;
const srt = (arquivo, texto) => fs.writeFileSync(arquivo, `1\n00:00:00,500 --> 00:00:05,500\n${texto}\n`);

const get = (rota, opcoes = {}) => fetch(rota.startsWith('http') ? rota : BASE + rota, { redirect: 'manual', ...opcoes });
const tok = (rota, senha = ADMIN) => `${rota}${rota.includes('?') ? '&' : '?'}token=${senha}`;

before(async () => {
  // fonte externa falsa: playlist HLS + segmento
  const pastaFonte = path.join(RAIZ, 'fonte');
  video(path.join(pastaFonte, 'src.mp4'), 4);
  execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(pastaFonte, 'src.mp4'), '-c', 'copy', '-f', 'hls', '-hls_time', '2',
    '-hls_playlist_type', 'vod', path.join(pastaFonte, 'vivo.m3u8')]);
  fonte = http.createServer((req, res) => {
    const f = path.join(pastaFonte, path.basename(req.url.split('?')[0]));
    if (req.url.startsWith('/lista.m3u')) {
      res.end(['#EXTM3U',
        `#EXTINF:-1 tvg-id="Publico.br@SD" group-title="News",Canal Público (1080p)`, `http://127.0.0.1:${portaFonte}/morto.m3u8`,
        `#EXTINF:-1 tvg-id="Publico.br@SD" group-title="News",Canal Público (480p)`, `http://127.0.0.1:${portaFonte}/vivo.m3u8`,
        `#EXTINF:-1 tvg-id="Exige.br@SD" group-title="Movies",Exige Referer`, '#EXTVLCOPT:http-referrer=https://exige.com.br/',
        `http://127.0.0.1:${portaFonte}/vivo.m3u8?ref=1`].join('\n'));
    } else if (fs.existsSync(f) && !req.url.startsWith('/morto')) {
      res.writeHead(200, { 'Content-Type': f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
      fs.createReadStream(f).pipe(res);
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise(r => fonte.listen(0, '127.0.0.1', r));
  portaFonte = fonte.address().port;

  // canal de série com legendas JP/PT, biblioteca e usuários
  for (const n of [1, 2]) {
    video(path.join(RAIZ, 'midia/serie', `Ep0${n}.mp4`), 8, 300 * n);
    srt(path.join(RAIZ, 'midia/serie', `Ep0${n}.ja.srt`), `こんにちは ${n}`);
    srt(path.join(RAIZ, 'midia/serie', `Ep0${n}.pt.srt`), `Olá ${n}`);
  }
  video(path.join(RAIZ, 'biblioteca/filmes/Filme Teste (2020).mp4'), 3, 440, 'jpn');
  srt(path.join(RAIZ, 'biblioteca/filmes/Filme Teste (2020).pt.srt'), 'Legenda do filme');
  video(path.join(RAIZ, 'biblioteca/series/Minha Serie/S01E01.mp4'), 2);
  video(path.join(RAIZ, 'biblioteca/series/Minha Serie/S01E02.mp4'), 2);

  const json = (f, d) => fs.writeFileSync(path.join(RAIZ, f), JSON.stringify(d));
  json('channels.json', [{ id: 'serie', nome: 'Série', grupo: 'Japonês', tipo: 'pasta', origem: 'midia/serie', idiomaLegenda: 'ja' }]);
  json('fontes.json', { listas: [`http://127.0.0.1:${portaFonte}/lista.m3u`], testarStreams: false });
  fs.writeFileSync(path.join(RAIZ, 'python-falso'), PYTHON_FALSO, { mode: 0o755 });
  json('config.json', { qualidades: ['480p', '360p'], segundosSegmento: 2,
    transcricao: { ativo: true, python: path.join(RAIZ, 'python-falso') } });
  json('usuarios.json', [{ usuario: 'dono', senha: ADMIN, admin: true }, { usuario: 'sala', senha: SALA }]);

  servidor = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, IPTV_RAIZ: RAIZ, PORT: String(PORTA), IPTV_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', d => { log += d; });
  servidor.stderr.on('data', d => { log += d; });
  // espera subir e baixar a lista pública
  for (let i = 0; i < 100; i++) {
    try {
      const s = await (await get('/saude')).json();
      if (s.listaAtualizadaEm) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`servidor não subiu:\n${log}`);
});

after(() => {
  servidor?.kill('SIGTERM');
  fonte?.close();
  fs.rmSync(RAIZ, { recursive: true, force: true });
});

test('pede senha e aceita token, Bearer e usuário da sala', async () => {
  assert.equal((await get('/playlist.m3u')).status, 401);
  assert.equal((await get('/playlist.m3u?token=errada')).status, 401);
  assert.equal((await get(tok('/playlist.m3u', SALA))).status, 200);
  assert.equal((await get('/api/canais', { headers: { Authorization: `Bearer ${ADMIN}` } })).status, 200);
  assert.equal((await get('/')).status, 200); // a página abre e pede a senha
});

test('playlist com numeração, token e links com troca automática', async () => {
  const m3u = await (await get(tok('/playlist.m3u'))).text();
  assert.match(m3u, /tvg-chno="1" tvg-name="Série"/);
  assert.match(m3u, new RegExp(`${BASE}/hls/serie/index\\.m3u8\\?token=${ADMIN}`));
  assert.match(m3u, /\/canal\/x-publico-br-sd\.m3u8\?token=/);
  assert.match(m3u, /url-tvg="[^"]*epg\.xml\?token=/);
});

test('canal local: qualidades, legendas JP/PT e pedaço de legenda alinhado', async () => {
  const master = await (await get(tok('/hls/serie/index.m3u8'))).text();
  assert.match(master, /TYPE=SUBTITLES.*LANGUAGE="ja",DEFAULT=YES/);
  assert.match(master, /LANGUAGE="pt",DEFAULT=NO/);
  assert.match(master, /NAME="480p"/);
  assert.match(master, /q1\.m3u8\?token=/);
  const q0 = await (await get(tok('/hls/serie/q0.m3u8'))).text();
  assert.match(q0, /#EXT-X-DISCONTINUITY-SEQUENCE:\d+/);
  const seg = q0.split('\n').find(l => l.startsWith('r'));
  const ts = await get(`/hls/serie/${seg}`);
  assert.equal(ts.status, 200);
  assert.ok((await ts.arrayBuffer()).byteLength > 1000);
  const sub = await (await get(tok('/hls/serie/sub_ja.m3u8'))).text();
  const vttUri = sub.split('\n').find(l => l.startsWith('sub_ja/'));
  const vtt = await (await get(`/hls/serie/${vttUri}`)).text();
  assert.match(vtt, /^WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:\d+,LOCAL:/);
});

test('canal público: pula o link morto e redireciona para o reserva', async () => {
  const r = await get(tok('/canal/x-publico-br-sd.m3u8'));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `http://127.0.0.1:${portaFonte}/vivo.m3u8`);
  assert.match(log, /trocando para o reserva/);
});

test('fonte que exige Referer passa pelo proxy assinado', async () => {
  const r = await get(tok('/canal/x-exige-br-sd.m3u8'));
  assert.equal(r.status, 200);
  const pl = await r.text();
  const seg = pl.split('\n').find(l => l.startsWith('/proxy/'));
  assert.ok(seg, pl);
  assert.equal((await get(seg)).status, 200);
  const adulterado = seg.replace(/u=[^&]+/, `u=${encodeURIComponent('http://127.0.0.1:1/x')}`);
  assert.equal((await get(adulterado)).status, 403);
});

test('API Xtream: login, canais, filmes, séries e arquivo com Range', async () => {
  const q = `username=dono&password=${ADMIN}`;
  const login = await (await get(`/player_api.php?${q}`)).json();
  assert.equal(login.user_info.auth, 1);
  assert.equal((await get('/player_api.php?username=dono&password=errada')).status, 401);
  const vivos = await (await get(`/player_api.php?${q}&action=get_live_streams`)).json();
  assert.ok(vivos.some(c => c.name === 'Série'));
  const filmes = await (await get(`/player_api.php?${q}&action=get_vod_streams`)).json();
  assert.equal(filmes[0].name, 'Filme Teste');
  const series = await (await get(`/player_api.php?${q}&action=get_series`)).json();
  const info = await (await get(`/player_api.php?${q}&action=get_series_info&series_id=${series[0].series_id}`)).json();
  assert.equal(info.episodes['1'].length, 2);
  const parcial = await get(`/movie/dono/${ADMIN}/${filmes[0].stream_id}.mp4`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(parcial.status, 206);
  assert.equal((await parcial.arrayBuffer()).byteLength, 100);
  const vivo = await get(`/live/dono/${ADMIN}/${vivos.find(c => c.name === 'Série').stream_id}.m3u8`);
  assert.equal(vivo.status, 302);
});

test('biblioteca no player web, com legenda do filme', async () => {
  const bib = await (await get(tok('/api/biblioteca'))).json();
  assert.equal(bib.filmes.length, 1);
  assert.equal(bib.series[0].episodios.length, 2);
  const legs = await (await get(bib.filmes[0].legendas)).json();
  assert.deepEqual(legs.map(l => l.idioma), ['pt']);
  const vtt = await (await get(legs[0].url)).text();
  assert.match(vtt, /Legenda do filme/);
});

test('guia de programação gerado pela pasta da série', async () => {
  const xml = await (await get(tok('/epg.xml'))).text();
  assert.match(xml, /<channel id="serie">/);
  assert.match(xml, /<programme channel="serie" start="\d{14} [+-]\d{4}"[^>]*><title>Ep0[12]<\/title>/);
  assert.match(xml, /<channel id="x-publico-br-sd">/);
});

test('painel: só administrador; favoritos aplicados sem reiniciar; validação', async () => {
  assert.equal((await get(tok('/api/admin/estado', SALA))).status, 403);
  const estado = await (await get(tok('/api/admin/estado'))).json();
  assert.ok(estado.canais.length >= 3);
  const put = (rota, corpo) => get(tok(`/api/admin/${rota}`), { method: 'PUT', body: JSON.stringify(corpo), headers: { 'Content-Type': 'application/json' } });
  assert.equal((await put('preferencias', { favoritos: ['x-publico-br-sd'], ocultos: ['x-exige-br-sd'], numeros: {} })).status, 200);
  const m3u = await (await get(tok('/playlist.m3u'))).text();
  assert.match(m3u.split('\n')[1], /tvg-id="x-publico-br-sd" tvg-chno="1".*group-title="★ Favoritos"/);
  assert.doesNotMatch(m3u, /x-exige-br-sd/);
  const ruim = await put('meus-canais', [{ id: 'Inválido!', nome: 'x', tipo: 'teste' }]);
  assert.equal(ruim.status, 400);
  assert.match((await ruim.json()).erro, /id inválido/);
  const semAdmin = await put('usuarios', [{ usuario: 'so', senha: 'senha-qualquer' }]);
  assert.equal(semAdmin.status, 400);
});

test('legenda automática em japonês: transcreve o filme japonês, pula áudio em outro idioma', async () => {
  const post = rota => get(tok(`/api/admin/${rota}`), { method: 'POST' });
  assert.equal((await post('transcrever')).status, 200);
  let t;
  for (let i = 0; i < 100; i++) {
    t = (await (await get(tok('/api/admin/estado'))).json()).transcricao;
    if (t.fila === 0 && !t.atual && t.feitas + t.naoJapones >= 3) break;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.equal(t.feitas, 1, JSON.stringify(t));      // o filme (áudio marcado como japonês)
  assert.equal(t.naoJapones, 2, JSON.stringify(t));  // os episódios (áudio sem marca, "detectado" como pt)
  const bib = await (await get(tok('/api/biblioteca'))).json();
  const legs = await (await get(bib.filmes[0].legendas)).json();
  assert.deepEqual(legs.map(l => [l.idioma, l.automatica]), [['pt', false], ['ja', true], ['jf', true]]);
  assert.equal(legs.find(l => l.idioma === 'jf').codigo, 'ja-Hrkt');
  const vtt = await (await get(legs.find(l => l.idioma === 'jf').url)).text();
  assert.match(vtt, /今日（きょう）は/);
});

test('modo estudo: cartões por usuário, exportação para o Anki e exclusão', async () => {
  const enviarJson = (rota, metodo, corpo, senha = ADMIN) => get(tok(rota, senha), { method: metodo, body: corpo && JSON.stringify(corpo), headers: { 'Content-Type': 'application/json' } });
  // sem o MeCab no "python" de teste a análise fica indisponível, mas o cartão é salvo assim mesmo
  assert.equal((await enviarJson('/api/estudo/analisar', 'POST', { texto: '今日は' })).status, 503);
  const r = await enviarJson('/api/estudo/cartoes', 'POST', { frase: '今日は<b>', traducao: 'Hoje', fonte: 'Filme Teste', tempo: 65 });
  const cartao = await r.json();
  assert.equal(cartao.fraseRuby, '今日は&lt;b&gt;');
  assert.equal((await (await get(tok('/api/estudo/cartoes', SALA))).json()).length, 0); // cada usuário tem os seus
  const anki = await (await get(tok('/api/estudo/anki.txt'))).text();
  assert.match(anki, /^#separator:tab\n#html:true/);
  assert.match(anki, /今日は&lt;b&gt;\t<i>Hoje<\/i><br><small>Filme Teste · 00:01:05<\/small>\tiptv japones/);
  assert.equal((await (await enviarJson(`/api/estudo/cartoes/${cartao.id}`, 'DELETE')).json()).ok, true);
  assert.equal((await (await get(tok('/api/estudo/cartoes'))).json()).length, 0);
});
