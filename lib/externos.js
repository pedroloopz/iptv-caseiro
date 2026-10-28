// Canais públicos: qual link de cada canal está valendo agora, verificação
// periódica e troca automática para um link reserva quando o atual cai.
// Também o proxy, para navegadores (CORS) e fontes que exigem User-Agent/Referer.
const crypto = require('crypto');
const { Readable } = require('stream');
const { estaNoAr, cabecalhos } = require('./atualizar');

const SEGREDO = crypto.randomBytes(16); // assina as URLs do proxy para ele não virar proxy aberto
const estado = new Map();               // id -> { ativo, noAr, verificadoEm, trocas }

function est(c) {
  if (!estado.has(c.id)) estado.set(c.id, { ativo: 0, noAr: true, verificadoEm: 0, trocas: 0 });
  return estado.get(c.id);
}
const origemAtiva = c => c.origens[est(c).ativo % c.origens.length];

function falhou(c, motivo) {
  const e = est(c);
  if (c.origens.length > 1) {
    e.ativo = (e.ativo + 1) % c.origens.length;
    e.trocas++;
    console.log(`[${c.id}] link ${motivo ? `falhou (${motivo})` : 'falhou'}; trocando para o reserva ${e.ativo + 1}/${c.origens.length}`);
  }
  e.verificadoEm = 0;
}

// Testa o link atual; se caiu, procura o próximo que responde
async function verificar(c, timeoutMs = 8000) {
  const e = est(c);
  const n = c.origens.length;
  for (let k = 0; k < n; k++) {
    const idx = (e.ativo + k) % n;
    if (await estaNoAr(c.origens[idx], timeoutMs)) {
      if (k) {
        e.trocas++;
        console.log(`[${c.id}] link ${e.ativo + 1} fora do ar; usando o ${idx + 1}/${n}`);
      }
      Object.assign(e, { ativo: idx, noAr: true, verificadoEm: Date.now() });
      return true;
    }
  }
  Object.assign(e, { noAr: false, verificadoEm: Date.now() });
  return false;
}

let verificando = false;
async function verificarTodos(canais, simultaneos = 10) {
  if (verificando) return;
  verificando = true;
  const inicio = Date.now();
  try {
    let i = 0;
    await Promise.all(Array.from({ length: simultaneos }, async () => {
      while (i < canais.length) await verificar(canais[i++]);
    }));
    const fora = canais.filter(c => !est(c).noAr).length;
    console.log(`[verificar] ${canais.length - fora}/${canais.length} canais públicos no ar ` +
      `(${Math.round((Date.now() - inicio) / 1000)} s)`);
  } finally {
    verificando = false;
  }
}

// ---------- proxy ----------

const assinar = txt => crypto.createHmac('sha256', SEGREDO).update(txt).digest('base64url').slice(0, 22);
const comToken = (url, token) => (token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url);

function urlProxy(c, idx, u, token) {
  return comToken(`/proxy/${c.id}?o=${idx}&u=${encodeURIComponent(u)}&s=${assinar(`${c.id}|${idx}|${u}`)}`, token);
}

function reescreverM3U8(texto, base, c, idx, token) {
  const abs = u => new URL(u, base).href;
  return texto.split(/\r?\n/).map(l => {
    if (!l.trim()) return l;
    if (l.startsWith('#')) return l.replace(/URI="([^"]+)"/g, (_, u) => `URI="${urlProxy(c, idx, abs(u), token)}"`);
    return urlProxy(c, idx, abs(l.trim()), token);
  }).join('\n');
}

const ehPlaylist = (r, url) => /mpegurl/i.test(r.headers.get('content-type') || '') || /\.m3u8?(\?|$)/i.test(url);

async function buscar(o, url, sinal) {
  return fetch(url, { headers: cabecalhos(o), signal: sinal || AbortSignal.timeout(15_000) });
}

function enviarCorpo(res, r, abortar) {
  res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'video/mp2t', 'Access-Control-Allow-Origin': '*' });
  const corpo = Readable.fromWeb(r.body);
  res.on('close', () => { corpo.destroy(); abortar?.(); });
  corpo.on('error', () => res.destroy()).pipe(res);
}

// Playlist principal do canal pelo proxy, trocando de link até um responder
async function proxyPrincipal(res, c, token) {
  for (let tentativa = 0; tentativa < c.origens.length; tentativa++) {
    const idx = est(c).ativo % c.origens.length;
    const o = c.origens[idx];
    try {
      const r = await buscar(o, o.url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (!ehPlaylist(r, r.url)) return enviarCorpo(res, r);
      const texto = await r.text();
      if (!texto.startsWith('#EXTM3U')) throw new Error('resposta não é playlist');
      Object.assign(est(c), { noAr: true, verificadoEm: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      return res.end(reescreverM3U8(texto, r.url, c, idx, token));
    } catch (e) {
      falhou(c, e.cause?.code || e.message);
    }
  }
  est(c).noAr = false;
  res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('todos os links deste canal estão fora do ar');
}

// /proxy/<id>?o=&u=&s= — sub-playlists e segmentos já reescritos
async function rotaProxy(req, res, c, url, token) {
  const u = url.searchParams.get('u');
  if (!u) return proxyPrincipal(res, c, token);
  const idx = Number(url.searchParams.get('o'));
  if (!c.origens[idx] || url.searchParams.get('s') !== assinar(`${c.id}|${idx}|${u}`)) {
    res.writeHead(403); return res.end('assinatura inválida');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let r;
  try {
    r = await buscar(c.origens[idx], u, ctrl.signal);
  } catch (e) {
    clearTimeout(timer);
    res.writeHead(502); return res.end(`fonte fora do ar: ${e.cause?.code || e.message}`);
  }
  clearTimeout(timer);
  if (!r.ok) { res.writeHead(502); return res.end(`fonte respondeu HTTP ${r.status}`); }
  if (ehPlaylist(r, r.url)) {
    const texto = await r.text();
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    return res.end(reescreverM3U8(texto, r.url, c, idx, token));
  }
  enviarCorpo(res, r, () => ctrl.abort());
}

// /canal/<id>.m3u8 — o link que vai na playlist dos apps. Redireciona para o link
// que está no ar; passa pelo proxy (a imagem vem pelo servidor) quando a fonte exige
// User-Agent/Referer ou, conforme "canaisPeloServidor", quando só toca no país do
// servidor (ex.: servidor na Alemanha abre ARD, ZDF, Pluto TV alemã).
async function rotaCanal(req, res, c, token, modo = 'geo') {
  for (let tentativa = 0; tentativa < c.origens.length; tentativa++) {
    const e = est(c);
    const o = origemAtiva(c);
    if (o.userAgent || o.referrer || modo === 'todos' || (modo === 'geo' && o.geo)) return proxyPrincipal(res, c, token);
    // confirma o link se a última verificação tem mais de 1 minuto
    if (Date.now() - e.verificadoEm < 60_000 || await estaNoAr(o, 5000)) {
      e.verificadoEm = Date.now();
      e.noAr = true;
      res.writeHead(302, { Location: o.url, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    falhou(c, 'não respondeu');
  }
  est(c).noAr = false;
  res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('todos os links deste canal estão fora do ar');
}

module.exports = { est, origemAtiva, falhou, verificar, verificarTodos, rotaProxy, rotaCanal, urlProxy, estado };
