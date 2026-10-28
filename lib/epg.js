// Guia de programação (XMLTV) num endereço só: /epg.xml junta
// - a programação manual de channels.json,
// - a grade gerada pelos seus vídeos (canais arquivo/pasta seguem o relógio),
// - guias externos (epgExterno) e, se ativado, o coletor do iptv-org/epg —
//   filtrados para os seus canais e com os ids trocados pelos do servidor.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { P } = require('./config');

const PARTES = path.join(P.dados, 'epg-partes');
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// XMLTV usa "YYYYMMDDHHMMSS +HHMM" no fuso local
function dataXmltv(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const fuso = `${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())} ${fuso}`;
}

function xmltvParaMs(s) {
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/);
  if (!m) return NaN;
  const [, a, mes, d, h, mi, se = '00', fuso = '+0000'] = m;
  const off = (fuso[0] === '-' ? -1 : 1) * (Number(fuso.slice(1, 3)) * 60 + Number(fuso.slice(3)));
  return Date.UTC(a, mes - 1, d, h, mi, se) - off * 60_000;
}

// Programação manual: [{ inicio: "20:00", fim: "22:00", titulo }] repetindo todo dia
function gradeManual(c, dias = 2) {
  const saida = [];
  for (let extra = 0; extra < dias; extra++) {
    for (const p of c.programacao || []) {
      const dia = new Date(); dia.setHours(0, 0, 0, 0); dia.setDate(dia.getDate() + extra);
      const hora = hhmm => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(dia); d.setHours(h, m); return d.getTime(); };
      saida.push({ inicio: hora(p.inicio), fim: hora(p.fim), titulo: p.titulo, descricao: p.descricao });
    }
  }
  return saida;
}

// id externo (como aparece nos guias) -> ids dos canais no servidor
function mapaIds(canais) {
  const mapa = new Map();
  const add = (k, id) => {
    if (!k) return;
    k = k.toLowerCase();
    if (!mapa.has(k)) mapa.set(k, new Set());
    mapa.get(k).add(id);
  };
  for (const c of canais) {
    add(c.tvgId, c.id);
    add(c.tvgId?.split('@')[0], c.id); // "Record.br@SD" também casa com "Record.br"
    add(c.epgId, c.id);                // id manual em channels.json, se o guia usar outro nome
  }
  return mapa;
}

function extrair(xml, mapa, desdeMs = Date.now() - 6 * 3600_000) {
  const saida = [];
  for (const m of xml.matchAll(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/g)) {
    const attrs = m[1];
    const ch = (attrs.match(/channel="([^"]*)"/) || [])[1];
    if (!ch) continue;
    const ids = mapa.get(ch.toLowerCase()) || mapa.get(ch.toLowerCase().split('@')[0]);
    if (!ids) continue;
    const stop = (attrs.match(/stop="([^"]*)"/) || [])[1];
    if (stop && xmltvParaMs(stop) < desdeMs) continue;
    // um programa por linha: facilita filtrar o arquivo final por canal
    const corpo = m[2].replace(/\s*\n\s*/g, ' ');
    for (const id of ids) {
      saida.push(`  <programme${attrs.replace(/\s+/g, ' ').replace(/channel="[^"]*"/, `channel="${id}"`)}>${corpo}</programme>`);
    }
  }
  return saida;
}

function decodificar(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return buf.toString('utf8');
}

function gravarParte(nome, linhas) {
  fs.mkdirSync(PARTES, { recursive: true });
  fs.writeFileSync(path.join(PARTES, `${nome}.xml`), linhas.join('\n'));
  juntarPartes();
}

function juntarPartes() {
  let partes = [];
  try { partes = fs.readdirSync(PARTES).filter(f => f.endsWith('.xml')); } catch {}
  const texto = partes.map(f => fs.readFileSync(path.join(PARTES, f), 'utf8')).filter(Boolean).join('\n');
  fs.writeFileSync(`${P.epgExterno}.tmp`, texto);
  fs.renameSync(`${P.epgExterno}.tmp`, P.epgExterno);
}

async function atualizarExterno(canais, urls, grabber, baixar) {
  const mapa = mapaIds(canais);
  const validas = new Set();
  for (const url of urls || []) {
    const nome = `url-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 10)}`;
    validas.add(`${nome}.xml`);
    try {
      const linhas = extrair(decodificar(await baixar(url, true)), mapa);
      gravarParte(nome, linhas);
      console.log(`[epg] ${url}: ${linhas.length} programas para os seus canais`);
    } catch (e) {
      console.warn(`[epg] ${url}: ${e.message}`);
    }
  }
  // remove partes de URLs que saíram da configuração
  try {
    for (const f of fs.readdirSync(PARTES)) {
      if (f.startsWith('url-') && !validas.has(f)) fs.rmSync(path.join(PARTES, f));
    }
    juntarPartes();
  } catch {}
  if (grabber?.ativo) {
    rodarGrabber(canais, grabber, baixar, mapa).catch(e => console.warn(`[epg] coletor iptv-org: ${e.message}`));
  }
}

function executar(cmd, args, opcoes = {}) {
  return new Promise((ok, falha) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32', ...opcoes });
    let erro = '';
    p.stderr.on('data', d => { erro = (erro + d).slice(-2000); });
    const timer = setTimeout(() => p.kill('SIGTERM'), opcoes.timeoutMs || 60 * 60_000);
    p.on('error', falha);
    p.on('exit', code => {
      clearTimeout(timer);
      code === 0 ? ok() : falha(new Error(`${cmd} ${args[0]} saiu com código ${code}: ${erro.trim().split('\n').pop()}`));
    });
  });
}

// Roda o coletor oficial (github.com/iptv-org/epg) só para os canais que você tem.
// Precisa de git e npm; na primeira vez baixa e instala o projeto em dados/epg-grabber.
let coletando = false;
async function rodarGrabber(canais, cfg, baixar, mapa) {
  if (coletando) return;
  coletando = true;
  try {
    const dir = path.join(P.dados, 'epg-grabber');
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      console.log('[epg] instalando o coletor do iptv-org (só na primeira vez)…');
      await executar('git', ['clone', '--depth', '1', 'https://github.com/iptv-org/epg.git', dir], { timeoutMs: 10 * 60_000 });
      await executar('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, timeoutMs: 20 * 60_000 });
    } else {
      await executar('git', ['-C', dir, 'pull', '--ff-only'], { timeoutMs: 5 * 60_000 }).catch(() => {});
    }
    const guias = JSON.parse(await baixar('https://iptv-org.github.io/api/guides.json'));
    const porCanal = new Map();
    for (const g of guias) {
      if (!porCanal.has(g.channel)) porCanal.set(g.channel, []);
      porCanal.get(g.channel).push(g);
    }
    const linhas = [];
    for (const c of canais) {
      if (!c.tvgId) continue;
      const [base, feed] = c.tvgId.split('@');
      const g = (porCanal.get(base) || []).sort((a, b) =>
        (b.feed === feed) - (a.feed === feed) || (b.lang === 'pt') - (a.lang === 'pt'))[0];
      if (g) {
        linhas.push(`  <channel site="${esc(g.site)}" lang="${esc(g.lang)}" xmltv_id="${esc(base)}" site_id="${esc(g.site_id)}">${esc(g.site_name)}</channel>`);
      }
    }
    if (!linhas.length) return console.log('[epg] nenhum canal seu tem guia no iptv-org');
    const arqCanais = path.join(P.dados, 'epg-canais.xml');
    const saida = path.join(P.dados, 'epg-coletado.xml');
    fs.writeFileSync(arqCanais, `<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n${linhas.join('\n')}\n</channels>\n`);
    console.log(`[epg] coletando guia de ${linhas.length} canais (pode levar vários minutos)…`);
    await executar('npm', ['run', 'grab', '---', `--channels=${arqCanais}`, `--output=${saida}`,
      `--days=${cfg.dias}`, `--maxConnections=${cfg.conexoes}`], { cwd: dir });
    const programas = extrair(fs.readFileSync(saida, 'utf8'), mapa);
    gravarParte('iptv-org', programas);
    console.log(`[epg] coletor iptv-org: ${programas.length} programas`);
  } finally {
    coletando = false;
  }
}

let cacheExterno = { mtime: 0, texto: '' };
function lerExterno() {
  try {
    const st = fs.statSync(P.epgExterno);
    if (st.mtimeMs !== cacheExterno.mtime) cacheExterno = { mtime: st.mtimeMs, texto: fs.readFileSync(P.epgExterno, 'utf8') };
    return cacheExterno.texto;
  } catch {
    return '';
  }
}

// canais: os visíveis; grades: Map id -> [{ inicio, fim, titulo, descricao }]
function gerar(canais, grades) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="iptv-caseiro">'];
  for (const c of canais) {
    out.push(`  <channel id="${esc(c.id)}"><display-name>${esc(c.nome)}</display-name>` +
      `${c.logo ? `<icon src="${esc(c.logo)}"/>` : ''}</channel>`);
  }
  for (const [id, lista] of grades) {
    for (const p of lista) {
      out.push(`  <programme channel="${esc(id)}" start="${dataXmltv(p.inicio)}" stop="${dataXmltv(p.fim)}">` +
        `<title>${esc(p.titulo)}</title>${p.descricao ? `<desc>${esc(p.descricao)}</desc>` : ''}</programme>`);
    }
  }
  const visiveis = new Set(canais.map(c => c.id));
  const externo = lerExterno();
  if (externo) {
    for (const linha of externo.split('\n')) {
      const id = (linha.match(/channel="([^"]*)"/) || [])[1];
      if (id && visiveis.has(id)) out.push(linha);
    }
  }
  out.push('</tv>');
  return out.join('\n') + '\n';
}

module.exports = { gerar, gradeManual, atualizarExterno, extrair, mapaIds, dataXmltv, xmltvParaMs, decodificar, esc };
