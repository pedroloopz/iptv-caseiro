// IPTV caseiro: seus vídeos viram canais ao vivo (seguindo o relógio, com legendas
// selecionáveis), canais públicos do iptv-org com troca automática de link,
// biblioteca de filmes/séries e API Xtream para apps de TV. Só Node 20+ e ffmpeg.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const config = require('./lib/config');
const auth = require('./lib/auth');
const canais = require('./lib/canais');
const transmissao = require('./lib/transmissao');
const externos = require('./lib/externos');
const atualizador = require('./lib/atualizar');
const agenda = require('./lib/agenda');
const epg = require('./lib/epg');
const biblioteca = require('./lib/biblioteca');
const legendas = require('./lib/legendas');
const xtream = require('./lib/xtream');
const transcricao = require('./lib/transcricao');
const estudo = require('./lib/estudo');
const { sondar } = require('./lib/midia');
const { spawn } = require('child_process');

const PORTA = Number(process.env.PORT) || 8080;
// versão do código (commit do git), para conferir se a atualização entrou: /saude
const VERSAO = (() => {
  try {
    return require('child_process').execFileSync('git', ['-C', __dirname, 'log', '-1', '--format=%h %cs'],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'desconhecida';
  }
})();
const INICIO = Date.now();
const { P } = config;

config.prepararRaiz();
fs.rmSync(P.hls, { recursive: true, force: true });
fs.mkdirSync(P.hls, { recursive: true });

let cfg = config.config();

// ---------- carregar e recarregar (edição à mão ou pelo painel, sem reiniciar) ----------

const assinaturaCanal = c => JSON.stringify({ ...c, favorito: 0, oculto: 0, numero: 0 });
const grades = new Map(); // id -> programação dos canais locais (para o EPG)

function recarregarTudo(motivo) {
  try {
    cfg = config.config();
    auth.carregar();
    const antes = new Map(canais.todos().map(c => [c.id, assinaturaCanal(c)]));
    canais.recarregar();
    // canal alterado ou removido: derruba a transmissão para religar com a configuração nova
    for (const id of [...transmissao.ativas.keys()]) {
      const c = canais.porId(id);
      if (!c || antes.get(id) !== assinaturaCanal(c)) transmissao.parar(id);
    }
    if (motivo) console.log(`[config] ${motivo} recarregado`);
    atualizarGrades();
  } catch (e) {
    console.error(`[config] ${e.message} — mantendo a configuração anterior`);
  }
}

async function atualizarGrades() {
  for (const c of canais.todos().filter(x => x.local)) {
    let lista = epg.gradeManual(c);
    if (c.tipo === 'arquivo' || c.tipo === 'pasta') {
      try {
        const itens = await agenda.montar(c);
        lista = lista.concat(agenda.grade(itens, Date.now() - 3600_000, Date.now() + 36 * 3600_000));
      } catch {}
    }
    grades.set(c.id, lista);
  }
}

// canais públicos que falharam no teste somem dos apps e da playlist (o painel mostra todos)
canais.definirFiltro(c => c.local || !cfg.esconderForaDoAr || externos.est(c).noAr !== false);
recarregarTudo();
if (auth.aberto()) console.warn('[auth] nenhum usuário em usuarios.json: acesso LIVRE, inclusive ao painel. Use só na rede de casa.');
config.observar(nome => recarregarTudo(nome));
biblioteca.escanear();

// ---------- tarefas periódicas ----------

let ultimaVerificacao = Date.now();

async function atualizarSePreciso(forcar = false) {
  if (!forcar && !atualizador.precisaAtualizar()) return;
  try {
    await atualizador.atualizar();
    externos.estado.clear(); // a lista nova acabou de ser testada: vale o resultado dela
    recarregarTudo('lista pública');
    ultimaVerificacao = Date.now(); // acabou de testar tudo
  } catch (e) {
    console.error(`[atualizar] ${e.message}`);
  }
}

function verificarSePreciso(forcar = false) {
  if (!forcar && Date.now() - ultimaVerificacao < cfg.verificarACadaMinutos * 60_000) return;
  ultimaVerificacao = Date.now();
  externos.verificarTodos(canais.externos().filter(c => !c.oculto)).catch(e => console.error(`[verificar] ${e.message}`));
}

atualizarSePreciso();
setInterval(() => atualizarSePreciso(), 10 * 60_000);
setInterval(() => verificarSePreciso(), 60_000);
setInterval(() => { biblioteca.escanear(); atualizarGrades(); }, 10 * 60_000);
setTimeout(() => estudo.baixarDicionario(), 15_000);
// legendas automáticas em japonês (se ativadas): procura vídeos novos sem legenda
setTimeout(() => transcricao.varrer().catch(e => console.warn(`[transcrição] ${e.message}`)), 20_000);
setInterval(() => transcricao.varrer().catch(e => console.warn(`[transcrição] ${e.message}`)), 30 * 60_000);
transmissao.vigiarOciosos(cfg.ociosoSegundos);

// ---------- utilitários HTTP ----------

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime' };

function enviar(res, status, corpo, tipo = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': tipo, 'Access-Control-Allow-Origin': '*', ...extra });
  res.end(corpo);
}
const json = (res, dados, status = 200) => enviar(res, status, JSON.stringify(dados), 'application/json; charset=utf-8');

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}
const comToken = (url, token) => (token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url);

// acrescenta o token em cada endereço de uma playlist HLS (segmentos, legendas, qualidades)
function tokenNaPlaylist(texto, token) {
  if (!token) return texto;
  return texto.split('\n').map(l => {
    if (l.startsWith('#')) return l.replace(/URI="([^"]+)"/g, (_, u) => `URI="${comToken(u, token)}"`);
    return l.trim() ? comToken(l, token) : l;
  }).join('\n');
}

function lerTexto(req, limite) {
  return new Promise((ok, falha) => {
    let tam = 0;
    const partes = [];
    req.on('data', d => {
      tam += d.length;
      if (tam > limite) { falha(new Error('corpo grande demais')); req.destroy(); } else partes.push(d);
    });
    req.on('end', () => ok(Buffer.concat(partes).toString('utf8')));
    req.on('error', falha);
  });
}

function lerCorpo(req, limite = 2 * 1024 * 1024) {
  return new Promise((ok, falha) => {
    let tam = 0;
    const partes = [];
    req.on('data', d => {
      tam += d.length;
      if (tam > limite) { falha(new Error('corpo grande demais')); req.destroy(); } else partes.push(d);
    });
    req.on('end', () => {
      try { ok(JSON.parse(Buffer.concat(partes).toString('utf8') || 'null')); } catch { falha(new Error('JSON inválido')); }
    });
    req.on('error', falha);
  });
}

function servirArquivo(req, res, arquivo, tipo) {
  let st;
  try { st = fs.statSync(arquivo); } catch { return enviar(res, 404, 'não encontrado'); }
  tipo ||= TIPOS[path.extname(arquivo).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const base = { 'Content-Type': tipo, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
  if (range && (range[1] !== '' || range[2] !== '')) {
    const ini = range[1] === '' ? Math.max(0, st.size - Number(range[2])) : Number(range[1]);
    let fim = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
    if (ini >= st.size || fim < ini) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    fim = Math.min(fim, st.size - 1);
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${ini}-${fim}/${st.size}`, 'Content-Length': fim - ini + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(arquivo, { start: ini, end: fim }).pipe(res);
  }
  res.writeHead(200, { ...base, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(arquivo).pipe(res);
}

// ---------- playlist M3U e guia ----------

function playlistM3U(base, token) {
  const guia = comToken(`${base}/epg.xml`, token);
  const linhas = [`#EXTM3U url-tvg="${guia}" x-tvg-url="${guia}"`];
  for (const c of canais.visiveis()) {
    linhas.push(`#EXTINF:-1 tvg-id="${epg.esc(c.id)}" tvg-chno="${c.numero}" tvg-name="${epg.esc(c.nome)}"` +
      `${c.logo ? ` tvg-logo="${epg.esc(c.logo)}"` : ''} group-title="${epg.esc(canais.grupoDe(c))}",${c.nome}`);
    if (c.local) {
      linhas.push(comToken(`${base}/hls/${c.id}/index.m3u8`, token));
    } else if (cfg.linksDiretos) {
      const o = externos.origemAtiva(c);
      if (o.userAgent) linhas.push(`#EXTVLCOPT:http-user-agent=${o.userAgent}`);
      if (o.referrer) linhas.push(`#EXTVLCOPT:http-referrer=${o.referrer}`);
      linhas.push(o.url);
    } else {
      linhas.push(comToken(`${base}/canal/${c.id}.m3u8`, token));
    }
  }
  return linhas.join('\n') + '\n';
}

const gerarEpg = () => epg.gerar(canais.visiveis(), new Map([...grades].filter(([id]) => canais.porId(id))));

// ---------- rotas ----------

// Canal ao vivo como MPEG-TS contínuo (formato ".ts" que vários apps Xtream pedem por
// padrão): o ffmpeg só reempacota o HLS, sem converter — leve até em máquina pequena
function transmitirTs(res, c, token) {
  let entrada;
  const extras = [];
  if (c.local) {
    entrada = `http://127.0.0.1:${PORTA}/hls/${c.id}/index.m3u8${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  } else {
    const o = externos.origemAtiva(c);
    entrada = o.url;
    if (o.userAgent) extras.push('-user_agent', o.userAgent);
    if (o.referrer) extras.push('-headers', `Referer: ${o.referrer}\r\n`);
  }
  const rede = /^https?:/.test(entrada) ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : [];
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...rede, ...extras, '-i', entrada,
    '-c', 'copy', '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', d => process.stderr.write(`[${c.id} .ts] ${d}`));
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
  p.stdout.pipe(res);
  res.on('close', () => p.kill('SIGKILL'));
  p.on('exit', code => {
    if (code && !c.local) externos.falhou(c, `ffmpeg ${code}`);
    res.end();
  });
}

async function rotaHls(req, res, c, arquivo, token) {
  if (!c?.local) return enviar(res, 404, 'canal não encontrado');
  const t = transmissao.obter(c, cfg);
  const playlist = pl => (pl ? enviar(res, 200, tokenNaPlaylist(pl, token), TIPOS['.m3u8'], { 'Cache-Control': 'no-cache' })
    : enviar(res, 404, 'ainda não disponível'));
  let m;
  if (arquivo === 'index.m3u8' || arquivo === 'master.m3u8') {
    if (!(await transmissao.aguardarPronta(t))) return enviar(res, 503, t.erro || 'canal iniciando, tente de novo');
    return playlist(t.master());
  }
  if ((m = arquivo.match(/^q(\d)\.m3u8$/))) return playlist(t.playlistQualidade(Number(m[1])));
  if ((m = arquivo.match(/^sub_([a-z]{2,3})\.m3u8$/))) return playlist(t.playlistLegenda(m[1]));
  if ((m = arquivo.match(/^sub_([a-z]{2,3})\/(\d+)\.vtt$/))) {
    try {
      const vtt = await t.pedacoLegenda(m[1], Number(m[2]));
      return vtt === null ? enviar(res, 404, 'expirou') : enviar(res, 200, vtt, TIPOS['.vtt']);
    } catch (e) {
      return enviar(res, 500, `legenda: ${e.message}`);
    }
  }
  const seg = t.arquivoSegmento(arquivo);
  if (seg) return servirArquivo(req, res, seg, TIPOS['.ts']);
  enviar(res, 404, 'não encontrado');
}

async function rotaVod(req, res, item, resto, token) {
  if (!item || !item.arquivo) return enviar(res, 404, 'não encontrado');
  if (!resto) return servirArquivo(req, res, item.arquivo);
  const fontes = () => sondar(item.arquivo).catch(() => null)
    .then(info => legendas.descobrir(item.arquivo, info, cfg.idiomaLegendaPadrao));
  if (resto === '/legendas.json') {
    const achadas = await fontes();
    return json(res, Object.keys(achadas).map(i => ({ idioma: i, codigo: legendas.codigoIdioma(i), nome: legendas.nomeIdioma(i),
      automatica: Boolean(achadas[i].auto), url: comToken(`/vod/${item.id}/legenda/${i}.vtt`, token) })));
  }
  const m = resto.match(/^\/legenda\/([a-z]{2,3})\.vtt$/);
  if (m) {
    const f = (await fontes())[m[1]];
    if (!f) return enviar(res, 404, 'sem legenda nesse idioma');
    try {
      return servirArquivo(req, res, await legendas.paraVtt(item.arquivo, f), TIPOS['.vtt']);
    } catch (e) {
      return enviar(res, 500, `legenda: ${e.message}`);
    }
  }
  enviar(res, 404, 'não encontrado');
}

function estadoAdmin() {
  return {
    canais: canais.todos().map(c => ({ id: c.id, nome: c.nome, grupo: c.grupo, local: c.local, numero: c.numero,
      favorito: c.favorito, oculto: c.oculto, links: c.origens?.length, noAr: c.local ? null : externos.est(c).noAr,
      ligado: transmissao.ativas.has(c.id) })),
    meusCanais: config.meusCanais(),
    preferencias: config.preferencias(),
    usuarios: config.usuarios().map(u => ({ usuario: u.usuario, senha: u.senha, admin: Boolean(u.admin), ativo: u.ativo !== false })),
    config: config.lerJson(P.config, {}),
    fontes: config.lerJson(P.fontes, {}),
    listaAtualizadaEm: canais.atualizadoEm(),
    biblioteca: { filmes: biblioteca.filmes().length, series: biblioteca.series().length },
    acessoLivre: auth.aberto(),
    transcricao: transcricao.resumo(),
  };
}

async function rotaAdmin(req, res, rota) {
  const salvar = async (arquivo, validar) => {
    const dados = await lerCorpo(req);
    validar?.(dados);
    config.gravarJson(arquivo, dados);
    recarregarTudo(path.basename(arquivo));
    json(res, { ok: true });
  };
  try {
    if (req.method === 'GET' && rota === 'estado') return json(res, estadoAdmin());
    if (req.method === 'PUT' && rota === 'preferencias') return await salvar(P.preferencias, d => {
      if (!d || !Array.isArray(d.favoritos) || !Array.isArray(d.ocultos) || typeof d.numeros !== 'object') throw new Error('formato: {favoritos:[], ocultos:[], numeros:{}}');
    });
    if (req.method === 'PUT' && rota === 'meus-canais') return await salvar(P.canais, canais.validarMeus);
    if (req.method === 'PUT' && rota === 'usuarios') return await salvar(P.usuarios, auth.validar);
    if (req.method === 'PUT' && rota === 'config') return await salvar(P.config, d => { if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('config.json deve ser um objeto { }'); });
    if (req.method === 'PUT' && rota === 'fontes') return await salvar(P.fontes, d => { if (!d || !Array.isArray(d.listas)) throw new Error('fontes.json precisa de "listas": [ ... ]'); });
    if (req.method === 'POST' && rota === 'atualizar') { atualizarSePreciso(true); return json(res, { ok: true, msg: 'atualização iniciada' }); }
    if (req.method === 'POST' && rota === 'verificar') { verificarSePreciso(true); return json(res, { ok: true, msg: 'verificação iniciada' }); }
    if (req.method === 'POST' && rota === 'biblioteca') { biblioteca.escanear(); return json(res, { ok: true, filmes: biblioteca.filmes().length, series: biblioteca.series().length }); }
    if (req.method === 'POST' && rota === 'gerar-senha') return json(res, { senha: auth.gerarSenha() });
    if (req.method === 'POST' && rota === 'transcrever') {
      if (!cfg.transcricao.ativo) throw new Error('ative "transcricao.ativo" em Ajustes (config.json) primeiro');
      const r = await transcricao.repetirErros();
      return json(res, { ok: true, msg: `procurando vídeos sem legenda japonesa (${r.fila} na fila)` });
    }
  } catch (e) {
    return json(res, { erro: e.message }, 400);
  }
  enviar(res, 404, 'não encontrado');
}

async function rotaEstudo(req, res, acao, id, usuario) {
  const quem = usuario.usuario;
  try {
    if (acao === 'analisar' && req.method === 'POST') {
      const { texto } = await lerCorpo(req, 64 * 1024) || {};
      try {
        return json(res, { tokens: await estudo.analisar(texto) });
      } catch (e) {
        return json(res, { erro: e.message }, 503);
      }
    }
    if (acao === 'estado') return json(res, estudo.estado());
    if (acao === 'cartoes' && req.method === 'GET') return json(res, estudo.listar(quem));
    if (acao === 'cartoes' && req.method === 'POST') return json(res, await estudo.adicionar(quem, await lerCorpo(req, 64 * 1024) || {}));
    if (acao === 'cartoes' && req.method === 'DELETE' && id) return json(res, { ok: estudo.remover(quem, id) });
    if (acao === 'anki.txt') {
      return enviar(res, 200, estudo.anki(quem), 'text/plain; charset=utf-8',
        { 'Content-Disposition': 'attachment; filename="iptv-japones-anki.txt"' });
    }
  } catch (e) {
    return json(res, { erro: e.message }, 400);
  }
  enviar(res, 404, 'não encontrado');
}

async function rotear(req, res) {
  const url = new URL(req.url.replace(/^\/{2,}/, '/'), 'http://x');
  // "http://servidor:8080/" no app vira "//player_api.php": junta as barras repetidas
  let rota = url.pathname.replace(/\/{2,}/g, '/');
  if (rota === '/panel_api.php') rota = '/player_api.php'; // nome usado por alguns apps Xtream antigos
  const ip = req.socket.remoteAddress;

  // alguns apps Xtream mandam usuário/senha no corpo (POST de formulário), não no endereço
  if (req.method === 'POST' && ['/player_api.php', '/get.php', '/xmltv.php'].includes(rota)) {
    const corpo = await lerTexto(req, 64 * 1024).catch(() => '');
    for (const [k, v] of new URLSearchParams(corpo)) if (!url.searchParams.has(k)) url.searchParams.set(k, v);
  }

  if (req.method === 'OPTIONS') {
    return enviar(res, 204, '', 'text/plain', { 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE' });
  }
  if (rota === '/saude') {
    return json(res, { ok: true, versao: VERSAO, desde: new Date(INICIO).toISOString(), canais: canais.visiveis().length,
      transmissoes: transmissao.ativas.size, listaAtualizadaEm: canais.atualizadoEm() });
  }

  // páginas (pedem a senha no navegador)
  if (rota === '/' || rota === '/index.html') return servirArquivo(req, res, path.join(P.publico, 'index.html'));
  if (rota === '/admin' || rota === '/admin.html') return servirArquivo(req, res, path.join(P.publico, 'admin.html'));

  // ---------- daqui para baixo precisa de senha ----------
  if (auth.bloqueado(ip)) {
    console.warn(`[acesso] ${ip} bloqueado tentou ${req.method} ${rota}`);
    return enviar(res, 429, 'muitas senhas erradas; tente de novo em 15 minutos');
  }
  const xt = xtream.resolverCaminho(rota);
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const credencial = xt ? { senha: xt.senha, usuario: xt.usuario }
    : url.searchParams.has('password') ? { senha: url.searchParams.get('password'), usuario: url.searchParams.get('username') }
    : { senha: url.searchParams.get('token') || bearer || null };
  const usuario = auth.porSenha(credencial.senha, credencial.usuario ?? undefined);
  if (!usuario) {
    if (credencial.senha) auth.registrarFalha(ip);
    // registro para diagnóstico (sem a senha): mostra o que cada app pede
    console.warn(`[acesso] login recusado: ${req.method} ${rota} usuário="${credencial.usuario ?? '(só token)'}" ` +
      `${credencial.senha ? 'senha errada' : 'sem senha'} ip=${ip} app="${(req.headers['user-agent'] || '').slice(0, 60)}"`);
    return rota === '/player_api.php' ? json(res, { user_info: { auth: 0 } }, 401) : enviar(res, 401, 'senha inválida');
  }
  const token = auth.aberto() ? '' : usuario.senha;
  const base = baseUrl(req);
  let m;

  if (rota === '/playlist.m3u' || rota === '/get.php') return enviar(res, 200, playlistM3U(base, token), 'audio/x-mpegurl; charset=utf-8');
  if (rota === '/epg.xml' || rota === '/xmltv.php') return enviar(res, 200, gerarEpg(), 'application/xml; charset=utf-8');
  if (rota === '/player_api.php') return json(res, xtream.api(url, usuario, base));

  if (xt) {
    if (!xt.item) return enviar(res, 404, 'não encontrado');
    if (xt.tipo === 'live') {
      if (xt.ext === 'ts') return transmitirTs(res, xt.item, token);
      const destino = xt.item.local ? `/hls/${xt.item.id}/index.m3u8` : `/canal/${xt.item.id}.m3u8`;
      res.writeHead(302, { Location: comToken(destino, token) });
      return res.end();
    }
    return servirArquivo(req, res, xt.item.arquivo);
  }

  if ((m = rota.match(/^\/hls\/([a-z0-9_-]+)\/(.+)$/))) return rotaHls(req, res, canais.porId(m[1]), m[2], token);
  if ((m = rota.match(/^\/canal\/([a-z0-9_-]+)\.m3u8$/))) {
    const c = canais.porId(m[1]);
    if (!c) return enviar(res, 404, 'canal não encontrado');
    if (c.local) { res.writeHead(302, { Location: comToken(`/hls/${c.id}/index.m3u8`, token) }); return res.end(); }
    return externos.rotaCanal(req, res, c, token, cfg.canaisPeloServidor);
  }
  if ((m = rota.match(/^\/proxy\/([a-z0-9_-]+)$/))) {
    const c = canais.porId(m[1]);
    if (!c || c.local) return enviar(res, 404, 'canal não encontrado');
    return externos.rotaProxy(req, res, c, url, token);
  }
  if ((m = rota.match(/^\/vod\/([a-z0-9-]+)(\/.*)?$/))) return rotaVod(req, res, biblioteca.porId(m[1]), m[2], token);

  if (rota === '/api/canais') {
    return json(res, {
      atualizadoEm: canais.atualizadoEm(),
      admin: Boolean(usuario.admin),
      canais: canais.visiveis().map(c => ({
        id: c.id, nome: c.nome, grupo: canais.grupoDe(c), logo: c.logo, numero: c.numero, favorito: c.favorito,
        externo: !c.local, ligado: transmissao.ativas.has(c.id), noAr: c.local ? true : externos.est(c).noAr,
        src: comToken(c.local ? `/hls/${c.id}/index.m3u8` : `/proxy/${c.id}`, token),
      })),
    });
  }
  if (rota === '/api/biblioteca') {
    const item = x => ({ id: x.id, titulo: x.meta?.nome || x.titulo, ano: x.ano, capa: x.meta?.capa, sinopse: x.meta?.sinopse,
      nota: x.meta?.nota, categoria: x.categoria, ext: x.ext, src: comToken(`/vod/${x.id}`, token),
      legendas: comToken(`/vod/${x.id}/legendas.json`, token) });
    return json(res, {
      filmes: biblioteca.filmes().map(item),
      series: biblioteca.series().map(s => ({ ...item(s), src: undefined, legendas: undefined,
        episodios: s.episodios.map(e => ({ ...item(e), temporada: e.temporada, episodio: e.episodio })) })),
    });
  }
  if ((m = rota.match(/^\/api\/estudo\/([\w.-]+)(?:\/([a-f0-9]+))?$/))) return rotaEstudo(req, res, m[1], m[2], usuario);
  if ((m = rota.match(/^\/api\/admin\/([a-z-]+)$/))) {
    if (!usuario.admin) return enviar(res, 403, 'só administradores');
    return rotaAdmin(req, res, m[1]);
  }
  console.warn(`[acesso] endereço desconhecido: ${req.method} ${rota} app="${(req.headers['user-agent'] || '').slice(0, 60)}"`);
  enviar(res, 404, 'não encontrado');
}

// ---------- servidor ----------

const tratar = (req, res) => rotear(req, res).catch(e => {
  console.error(`[http] ${req.method} ${req.url.replace(/(token|password)=[^&]+/g, '$1=***')}: ${e.stack || e.message}`);
  if (!res.headersSent) enviar(res, 500, 'erro interno');
  else res.destroy();
});

const usarHttps = Boolean(cfg.https.cert && cfg.https.key);
const servidor = usarHttps
  ? https.createServer({ cert: fs.readFileSync(cfg.https.cert), key: fs.readFileSync(cfg.https.key) }, tratar)
  : http.createServer(tratar);

servidor.listen(PORTA, () => {
  const proto = usarHttps ? 'https' : 'http';
  console.log(`IPTV no ar: ${proto}://localhost:${PORTA}   (painel: /admin)`);
  console.log(`Playlist M3U: ${proto}://SEU_IP:${PORTA}/playlist.m3u${auth.aberto() ? '' : '?token=SUA_SENHA'}`);
  console.log(`Apps Xtream (TiviMate, Smarters): servidor ${proto}://SEU_IP:${PORTA} + usuário e senha de usuarios.json`);
});

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => {
    for (const id of [...transmissao.ativas.keys()]) transmissao.parar(id);
    process.exit(0);
  });
}
