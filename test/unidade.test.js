// Testes de unidade: node --test (dentro da pasta iptv)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// cada execução usa uma raiz temporária, longe dos seus arquivos de verdade
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-unidade-'));
process.env.IPTV_RAIZ = RAIZ;
delete process.env.IPTV_TOKEN;

const { lerM3U, fonteSuspeita, naoTocavel, agrupar, espelho } = require('../lib/atualizar');
const agenda = require('../lib/agenda');
const legendas = require('../lib/legendas');
const epg = require('../lib/epg');
const auth = require('../lib/auth');
const canais = require('../lib/canais');
const cod = require('../lib/codificador');
const { temporadaEpisodio, tituloEAno } = require('../lib/biblioteca');
const { tituloDoArquivo } = require('../lib/midia');
const { lerPlaylist } = require('../lib/transmissao');
const { escolherAudio } = require('../lib/transcricao');
const estudo = require('../lib/estudo');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

test('lê M3U com atributos, User-Agent e Referer', () => {
  const itens = lerM3U([
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="Canal.br@SD" tvg-logo="http://x/l.png" group-title="News;General",Canal (720p) [Not 24/7]',
    '#EXTVLCOPT:http-user-agent=Mozilla/5.0 a=b',
    '#EXTVLCOPT:http-referrer=https://site.com.br/',
    'http://exemplo.com/a.m3u8',
    '#EXTINF:-1,Sem atributos',
    'http://exemplo.com/b.m3u8',
  ].join('\r\n'));
  assert.equal(itens.length, 2);
  assert.equal(itens[0].attrs['tvg-id'], 'Canal.br@SD');
  assert.equal(itens[0].userAgent, 'Mozilla/5.0 a=b');
  assert.equal(itens[0].referrer, 'https://site.com.br/');
  assert.equal(itens[1].nome, 'Sem atributos');
});

test('filtro de fontes suspeitas', () => {
  const cfg = { excluirIpSolto: true, excluirHosts: ['mov3.co'] };
  assert.equal(fonteSuspeita('http://170.84.165.204/Globo_HD/index.m3u8', cfg), true);
  assert.equal(fonteSuspeita('https://nhk4.mov3.co/hls/nhk.m3u8', cfg), true);
  assert.equal(fonteSuspeita('https://cdn.jmvstream.com/w/x/playlist.m3u8', cfg), false);
  assert.equal(fonteSuspeita('http://170.84.165.204/x', { excluirIpSolto: false, excluirHosts: [] }), false);
  assert.equal(naoTocavel('https://www.youtube.com/watch?v=x'), true);
  assert.equal(naoTocavel('[NO PUBLIC STREAM]'), true);
  assert.equal(naoTocavel('rtsp://camera.local/stream'), false);
  assert.equal(espelho('https://iptv-org.github.io/iptv/countries/br.m3u'),
    'https://raw.githubusercontent.com/iptv-org/iptv/gh-pages/countries/br.m3u');
});

test('agrupa links do mesmo canal com a melhor qualidade primeiro', () => {
  const itens = lerM3U([
    '#EXTINF:-1 tvg-id="A.br@SD" group-title="News",Canal A (480p)', 'http://a/480.m3u8',
    '#EXTINF:-1 tvg-id="A.br@SD" group-title="News",Canal A (1080p)', 'http://a/1080.m3u8',
    '#EXTINF:-1 group-title="Undefined",Canal B', 'http://b/1.m3u8',
    '#EXTINF:-1 tvg-id="A.br@HD",Canal A HD', 'http://a/hd.m3u8',
    '#EXTINF:-1 tvg-id="A.br@Portugal",Canal A Portugal', 'http://a/pt.m3u8',
    '#EXTINF:-1 tvg-id="Erste.de",Das Erste Ⓖ', 'http://de/erste.m3u8',
  ].join('\n'));
  const lista = agrupar(itens);
  assert.equal(lista.length, 4); // @HD vira reserva; @Portugal é outra versão
  const erste = lista.find(c => c.tvgId === 'Erste.de');
  assert.equal(erste.nome, 'Das Erste');
  assert.equal(erste.origens[0].geo, true);
  const a = lista.find(c => c.tvgId === 'A.br@SD');
  assert.equal(a.nome, 'Canal A');
  assert.deepEqual(a.origens.map(o => o.url), ['http://a/1080.m3u8', 'http://a/480.m3u8', 'http://a/hd.m3u8']);
  assert.equal(lista.find(c => c.nome === 'Canal B').grupo, 'Outros');
  const fixo = agrupar(lerM3U('#EXTINF:-1 group-title="News",Tagesschau\nhttp://de/1.m3u8').map(i => ({ ...i, grupoFixo: 'Alemanha' })));
  assert.equal(fixo[0].grupo, 'Alemanha');
  assert.match(a.id, /^x-/);
});

test('programação pelo relógio: posição e grade', () => {
  const itens = [{ titulo: 'A', duracao: 60 }, { titulo: 'B', duracao: 30 }];
  const t0 = agenda.ANCORA;
  assert.deepEqual(agenda.posicao(itens, t0), { indice: 0, offset: 0 });
  assert.deepEqual(agenda.posicao(itens, t0 + 70_000), { indice: 1, offset: 10 });
  assert.deepEqual(agenda.posicao(itens, t0 + 95_000), { indice: 0, offset: 5 }); // deu a volta
  const g = agenda.grade(itens, t0 + 70_000, t0 + 200_000);
  assert.equal(g[0].titulo, 'B');
  assert.equal(g[0].inicio, t0 + 60_000);
  assert.equal(g[1].inicio, t0 + 90_000);
  assert.equal(agenda.posicao([], t0), null);
});

test('legendas: idioma, leitura de VTT e pedaço com mapa de tempo', () => {
  assert.equal(legendas.normalizarIdioma('jpn'), 'ja');
  assert.equal(legendas.normalizarIdioma('pt-BR'), 'pt');
  assert.equal(legendas.normalizarIdioma('forced'), null);
  const cues = legendas.lerVtt('WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nOi\n\n00:01:00.000 --> 00:01:02.000 align:start\nTchau\nlinha 2\n');
  assert.deepEqual(cues, [{ ini: 1, fim: 3.5, texto: 'Oi' }, { ini: 60, fim: 62, texto: 'Tchau\nlinha 2' }]);
  const vtt = legendas.pedacoVtt(cues, 59, 63, 126000, 30);
  assert.match(vtt, /X-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:30\.000/);
  assert.match(vtt, /Tchau/);
  assert.doesNotMatch(vtt, /Oi/);
  assert.equal(legendas.pareceUtf8(Buffer.from('Ação', 'latin1')), false);
  assert.equal(legendas.pareceUtf8(Buffer.from('Ação', 'utf8')), true);
});

test('legendas: descobre arquivos ao lado do vídeo', () => {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'leg-'));
  for (const f of ['Ep01.mkv', 'Ep01.ja.srt', 'Ep01.pt-BR.srt', 'Ep01b.srt', 'Ep01.srt']) fs.writeFileSync(path.join(dir, f), '');
  const fontes = legendas.descobrir(path.join(dir, 'Ep01.mkv'), { legendas: [{ indice: 0, idioma: 'eng' }] }, 'es');
  assert.deepEqual(Object.keys(fontes).sort(), ['en', 'es', 'ja', 'pt']);
  assert.equal(fontes.en.embutida, 0);
  assert.match(fontes.es.arquivo, /Ep01\.srt$/);
});

test('guia: extrai programas dos seus canais e troca os ids', () => {
  const xml = `<tv><programme start="20990101000000 +0000" stop="20990101010000 +0000" channel="Record.br">
    <title>Jornal</title></programme>
    <programme start="20000101000000 +0000" stop="20000101010000 +0000" channel="Record.br"><title>Velho</title></programme>
    <programme start="20990101000000 +0000" stop="20990101010000 +0000" channel="Outro.br"><title>X</title></programme></tv>`;
  const mapa = epg.mapaIds([{ id: 'x-record-br-sd', tvgId: 'Record.br@SD' }]);
  const linhas = epg.extrair(xml, mapa);
  assert.equal(linhas.length, 1);
  assert.match(linhas[0], /channel="x-record-br-sd"/);
  assert.doesNotMatch(linhas[0], /\n/);
  assert.equal(epg.xmltvParaMs('20261023120000 -0300'), Date.UTC(2026, 9, 23, 15, 0, 0));
});

test('usuários: senha, administrador e limite de tentativas', () => {
  assert.equal(auth.carregar().length, 0);
  assert.equal(auth.aberto(), true);
  fs.writeFileSync(path.join(RAIZ, 'usuarios.json'), JSON.stringify([
    { usuario: 'dono', senha: 'senha-do-dono', admin: true },
    { usuario: 'sala', senha: 'senha-da-sala' },
    { usuario: 'antigo', senha: 'senha-antiga-x', ativo: false },
  ]));
  auth.carregar();
  assert.equal(auth.aberto(), false);
  assert.equal(auth.porSenha('senha-do-dono').usuario, 'dono');
  assert.equal(auth.porSenha('senha-da-sala', 'sala').admin, undefined);
  assert.equal(auth.porSenha('senha-da-sala', 'dono'), null);
  assert.equal(auth.porSenha('senha-antiga-x'), null);
  assert.equal(auth.porSenha('errada'), null);
  assert.throws(() => auth.validar([{ usuario: 'a', senha: 'curta' }]), /8 caracteres/);
  assert.throws(() => auth.validar([{ usuario: 'a', senha: '12345678' }, { usuario: 'b', senha: '12345678', admin: true }]), /diferente/);
  assert.throws(() => auth.validar([{ usuario: 'a', senha: '12345678' }]), /administrador/);
  for (let i = 0; i < auth.MAX_FALHAS - 1; i++) auth.registrarFalha('1.2.3.4');
  assert.equal(auth.bloqueado('1.2.3.4'), false);
  auth.registrarFalha('1.2.3.4');
  assert.equal(auth.bloqueado('1.2.3.4'), true);
  assert.equal(auth.bloqueado('5.6.7.8'), false);
  fs.rmSync(path.join(RAIZ, 'usuarios.json'));
});

test('canais: validação, favoritos, ocultos e numeração', () => {
  assert.throws(() => canais.validarMeus([{ id: 'A B', nome: 'x', tipo: 'teste' }]), /id inválido/);
  assert.throws(() => canais.validarMeus([{ id: 'a', nome: 'x', tipo: 'pasta' }]), /origem/);
  fs.writeFileSync(path.join(RAIZ, 'channels.json'), JSON.stringify([
    { id: 'um', nome: 'Um', tipo: 'teste' }, { id: 'dois', nome: 'Dois', tipo: 'teste' }, { id: 'tres', nome: 'Três', tipo: 'teste' },
  ]));
  fs.writeFileSync(path.join(RAIZ, 'preferencias.json'), JSON.stringify({ favoritos: ['tres'], ocultos: ['dois'], numeros: { um: 10 } }));
  canais.recarregar();
  const vis = canais.visiveis();
  assert.deepEqual(vis.map(c => [c.id, c.numero]), [['tres', 1], ['um', 10]]);
  assert.equal(canais.grupoDe(canais.porId('tres')), '★ Favoritos');
  assert.equal(canais.porNum(canais.numId('um')).id, 'um');
});

test('biblioteca: títulos, anos, temporadas e episódios', () => {
  assert.deepEqual(tituloEAno('/f/Meu.Filme.2019.1080p.BluRay.x264.mkv'), { titulo: 'Meu Filme', ano: 2019 });
  assert.deepEqual(tituloEAno('/f/Outro Filme (2005).mp4'), { titulo: 'Outro Filme', ano: 2005 });
  assert.deepEqual(temporadaEpisodio('Show.S02E05.720p.mkv', 0), { temporada: 2, episodio: 5 });
  assert.deepEqual(temporadaEpisodio('Temporada 3/Episódio 07.mp4', 0), { temporada: 3, episodio: 7 });
  assert.deepEqual(temporadaEpisodio('1x09 - Título.mkv', 0), { temporada: 1, episodio: 9 });
  assert.deepEqual(temporadaEpisodio('[Grupo] Anime - 12 [1080p].mkv', 0), { temporada: 1, episodio: 12 });
  assert.equal(tituloDoArquivo('/x/Meu_Video.2020.WEB-DL.mp4'), 'Meu Video 2020');
});

test('codificador: várias qualidades e aceleração por hardware', () => {
  const cfg = { segundosSegmento: 4, aceleracao: 'nvenc', dispositivoVaapi: '/dev/dri/renderD128', qualidades: ['720p', '360p'] };
  const c = { id: 'x' };
  const args = cod.argsSaidas({ cfg, c, dir: '.', qs: cod.qualidades(c, cfg) }).join(' ');
  assert.match(args, /split=2\[s0\]\[s1\]/);
  assert.match(args, /h264_nvenc/);
  assert.match(args, /q1\.m3u8/);
  assert.deepEqual(cod.argsGlobais({ ...cfg, aceleracao: 'vaapi' }), ['-vaapi_device', '/dev/dri/renderD128']);
  assert.throws(() => cod.qualidades({ qualidades: ['4k'] }, cfg), /qualidade desconhecida/);
  const copia = cod.argsSaidas({ cfg: { ...cfg, qualidades: ['720p'] }, c: { copiar: true }, dir: '.', qs: cod.qualidades({}, { qualidades: ['720p'] }) });
  assert.ok(copia.includes('copy'));
});

test('lê playlist do ffmpeg com sequência', () => {
  const f = path.join(RAIZ, 'q0.m3u8');
  fs.writeFileSync(f, '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:4.000000,\nq0_00005.ts\n#EXTINF:3.5,\nq0_00006.ts\n');
  assert.deepEqual(lerPlaylist(f), { seq: 5, segs: [{ dur: 4, uri: 'q0_00005.ts' }, { dur: 3.5, uri: 'q0_00006.ts' }] });
  assert.equal(lerPlaylist(path.join(RAIZ, 'nao-existe.m3u8')), null);
});

test('legenda automática: idioma da furigana, faixa de áudio e pasta das transcrições', () => {
  assert.equal(legendas.normalizarIdioma('ja-furigana'), 'jf');
  assert.equal(legendas.codigoIdioma('jf'), 'ja-Hrkt');
  assert.deepEqual(escolherAudio({ audios: [{ indice: 0, idioma: 'por' }, { indice: 1, idioma: 'jpn' }] }), { indice: 1, conferir: false });
  assert.equal(escolherAudio({ audios: [{ indice: 0, idioma: 'por' }, { indice: 1, idioma: 'eng' }] }), null);
  assert.deepEqual(escolherAudio({ audios: [{ indice: 0, idioma: 'und' }] }), { indice: 0, conferir: true });

  const dir = fs.mkdtempSync(path.join(RAIZ, 'auto-'));
  const video = path.join(dir, 'Anime 01.mkv');
  fs.writeFileSync(video, 'x');
  const auto = legendas.pastaAuto(video);
  fs.mkdirSync(auto, { recursive: true });
  fs.writeFileSync(path.join(auto, 'ja.srt'), '');
  fs.writeFileSync(path.join(auto, 'jf.srt'), '');
  let f = legendas.descobrir(video, null, 'pt');
  assert.equal(f.ja.auto, true);
  assert.equal(f.jf.auto, true);
  fs.writeFileSync(path.join(dir, 'Anime 01.ja.srt'), ''); // a sua legenda ganha da automática
  f = legendas.descobrir(video, null, 'pt');
  assert.equal(f.ja.auto, undefined);
});

// roda só se o Python tiver o MeCab (pip install fugashi unidic-lite)
const python = process.env.IPTV_PYTHON || 'python3';
let temMecab = false;
try { execFileSync(python, ['-c', 'import fugashi, unidic_lite'], { stdio: 'ignore' }); temMecab = true; } catch {}
test('furigana: leitura pelo contexto e só nos kanji', { skip: !temMecab && 'fugashi/unidic-lite não instalados' }, () => {
  const ent = path.join(RAIZ, 'f.srt'), sai = path.join(RAIZ, 'f2.srt');
  fs.writeFileSync(ent, '1\n00:00:01,000 --> 00:00:03,000\n今日は天気がいい。日本語を勉強して、食べ物を食べた。\n');
  execFileSync(python, [path.join(__dirname, '..', 'scripts', 'furigana.py'), ent, sai]);
  const texto = fs.readFileSync(sai, 'utf8');
  assert.match(texto, /今日（きょう）は天気（てんき）がいい/);
  assert.match(texto, /日本語（にほんご）を勉強（べんきょう）して/);
  assert.match(texto, /食（た）べ物（もの）を食（た）べた/);
  assert.match(texto, /00:00:01,000 --> 00:00:03,000/);
});

test('modo estudo: lê o .zip do dicionário e monta cartões para o Anki', () => {
  // zip mínimo com um arquivo comprimido (deflate)
  const conteudo = Buffer.from('{"words":[]}');
  const comp = zlib.deflateRawSync(conteudo);
  const nome = Buffer.from('jmdict.json');
  const cab = Buffer.alloc(30);
  cab.writeUInt32LE(0x04034b50, 0); cab.writeUInt16LE(8, 8); cab.writeUInt32LE(comp.length, 18);
  cab.writeUInt32LE(conteudo.length, 22); cab.writeUInt16LE(nome.length, 26);
  assert.equal(estudo.extrairZipUnico(Buffer.concat([cab, nome, comp])).toString(), '{"words":[]}');
  assert.throws(() => estudo.extrairZipUnico(Buffer.from('nada aqui, 30 bytes de lixo....')), /não é um \.zip/);

  const html = estudo.rubyHtml([{ ruby: [['食', 'た'], ['べ', null]] }, { ruby: [['<b>', null]] }]);
  assert.equal(html, '<ruby>食<rt>た</rt></ruby>べ&lt;b&gt;');
});

test('playlist de canal público: endereços relativos viram completos', () => {
  const { absolutizarM3U8 } = require('../lib/externos');
  const pl = absolutizarM3U8('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="chave.key"\n#EXTINF:4,\nseg1.ts\n/abs/seg2.ts\nhttps://cdn.x/seg3.ts\n',
    'https://fonte.com/canal/index.m3u8?t=1');
  assert.match(pl, /URI="https:\/\/fonte\.com\/canal\/chave\.key"/);
  assert.match(pl, /\nhttps:\/\/fonte\.com\/canal\/seg1\.ts\n/);
  assert.match(pl, /\nhttps:\/\/fonte\.com\/abs\/seg2\.ts\n/);
  assert.match(pl, /\nhttps:\/\/cdn\.x\/seg3\.ts\n/);
});

test('teste completo do link: vai até o vídeo e recusa bloqueio, DRM e página de erro', async () => {
  const { estaNoAr, pareceVideo } = require('../lib/atualizar');
  const http = require('http');
  const TS = Buffer.alloc(188 * 4, 0); TS[0] = 0x47;
  const rotas = {
    '/ok.m3u8': ['#EXTM3U\n#EXTINF:4,\nseg.ts\n'],
    '/master.m3u8': ['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvar/ok.m3u8\n'],
    '/var/ok.m3u8': ['#EXTM3U\n#EXTINF:4,\n../seg.ts\n'],
    '/geo.m3u8': ['#EXTM3U\n#EXTINF:4,\nproibido.ts\n'],
    '/drm.m3u8': ['#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\nseg.ts\n'],
    '/html.m3u8': ['#EXTM3U\n#EXTINF:4,\npagina.ts\n'],
    '/aes.m3u8': ['#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXTINF:4,\ncripto.ts\n'],
    '/naoplaylist.m3u8': ['<html>erro</html>'],
  };
  const srv = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (rotas[p]) { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end(rotas[p][0]); }
    if (p === '/seg.ts') { res.writeHead(206, { 'Content-Type': 'video/mp2t' }); return res.end(TS); }
    if (p === '/cripto.ts') { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(Buffer.from([0x9a, 0x13, 0x77])); }
    if (p === '/pagina.ts') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>bloqueado</html>'); }
    res.writeHead(403); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const u = p => ({ url: `http://127.0.0.1:${srv.address().port}${p}` });
  try {
    assert.equal(await estaNoAr(u('/ok.m3u8')), true);
    assert.equal(await estaNoAr(u('/master.m3u8')), true);    // desce da playlist principal para a qualidade
    assert.equal(await estaNoAr(u('/geo.m3u8')), false);      // vídeo responde 403 (bloqueio por país)
    assert.equal(await estaNoAr(u('/geo.m3u8'), 8000, false), true); // o teste antigo deixava passar
    assert.equal(await estaNoAr(u('/drm.m3u8')), false);      // proteção contra cópia
    assert.equal(await estaNoAr(u('/html.m3u8')), false);     // "vídeo" que é página de erro
    assert.equal(await estaNoAr(u('/aes.m3u8')), true);       // AES-128 comum toca
    assert.equal(await estaNoAr(u('/naoplaylist.m3u8')), false);
    assert.equal(await estaNoAr(u('/morto.m3u8')), false);
  } finally {
    srv.close();
  }
  assert.equal(pareceVideo(Buffer.from('....ftypisom'), 'video/mp4'), true);
  assert.equal(pareceVideo(Buffer.from([0x47, 0, 0]), 'text/html'), false);
});

test('canais: filtro extra esconde os fora do ar sem tirar do painel', () => {
  canais.definirFiltro(c => c.id !== 'um');
  assert.deepEqual(canais.visiveis().map(c => c.id), ['tres']);
  assert.ok(canais.todos().some(c => c.id === 'um'));
  canais.definirFiltro(() => true);
});
