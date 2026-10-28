// Baixa as listas públicas do iptv-org (github.com/iptv-org/iptv), testa cada
// link e grava em dados/externos.json os canais no ar — com TODOS os links que
// responderam, para o servidor trocar sozinho quando um cair.
const fs = require('fs');
const { P, fontes, config, gravarJson } = require('./config');
const epg = require('./epg');

// iptv-org.github.io às vezes é bloqueado por rede/firewall; o mesmo arquivo
// existe no branch gh-pages do repositório
function espelho(url) {
  const m = url.match(/^https:\/\/iptv-org\.github\.io\/(iptv|api)\/(.+)$/);
  return m ? `https://raw.githubusercontent.com/iptv-org/${m[1]}/gh-pages/${m[2]}` : null;
}

async function baixar(url, comoBuffer = false) {
  for (const u of [url, espelho(url)].filter(Boolean)) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(120_000) });
      if (r.ok) return comoBuffer ? Buffer.from(await r.arrayBuffer()) : await r.text();
      console.warn(`  ${u}: HTTP ${r.status}`);
    } catch (e) {
      console.warn(`  ${u}: ${e.cause?.code || e.message}`);
    }
  }
  throw new Error(`não consegui baixar ${url}`);
}

function lerM3U(texto) {
  const itens = [];
  let atual = null;
  for (const bruta of texto.split(/\r?\n/)) {
    const linha = bruta.trim();
    if (linha.startsWith('#EXTINF')) {
      const attrs = {};
      for (const [, k, v] of linha.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[k] = v;
      atual = { attrs, nome: linha.slice(linha.lastIndexOf(',') + 1).trim() };
    } else if (linha.startsWith('#EXTVLCOPT:') && atual) {
      const [k, ...v] = linha.slice(11).split('=');
      if (k === 'http-user-agent') atual.userAgent = v.join('=');
      if (k === 'http-referrer') atual.referrer = v.join('=');
    } else if (linha && !linha.startsWith('#') && atual) {
      itens.push({ ...atual, url: linha });
      atual = null;
    }
  }
  return itens;
}

function cabecalhos(o) {
  const h = { 'User-Agent': o.userAgent || 'Mozilla/5.0 (iptv-caseiro)' };
  if (o.referrer) h.Referer = o.referrer;
  return h;
}

async function estaNoAr(o, timeoutMs = 8000) {
  try {
    const r = await fetch(o.url, { headers: cabecalhos(o), signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    // lê só o começo: playlist HLS tem que começar com #EXTM3U; outros formatos basta responder
    const leitor = r.body.getReader();
    const { value } = await leitor.read();
    leitor.cancel().catch(() => {});
    const inicio = Buffer.from(value || []).toString('utf8', 0, 7);
    return /\.m3u8?(\?|$)/i.test(o.url) ? inicio === '#EXTM3U' : true;
  } catch {
    return false;
  }
}

async function emParalelo(itens, limite, fn) {
  const resultados = new Array(itens.length);
  let proximo = 0;
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (proximo < itens.length) {
      const i = proximo++;
      resultados[i] = await fn(itens[i]);
    }
  }));
  return resultados;
}

// Emissoras de verdade transmitem por CDN com domínio próprio; link num IP cru
// (http://170.84.x.x/Globo_HD/...) quase sempre é sinal de TV paga capturado e
// retransmitido sem autorização — além de cair o tempo todo.
function fonteSuspeita(url, cfg) {
  let host;
  try { host = new URL(url).hostname; } catch { return true; }
  if (cfg.excluirIpSolto && (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('['))) return true;
  return cfg.excluirHosts.some(h => host === h || host.endsWith(`.${h}`));
}

// páginas do YouTube não são stream: players de IPTV não tocam
const naoTocavel = url => /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(url) || !/^(https?|rtmp|rtsp):\/\//i.test(url);

const slug = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'canal';

const resolucao = nome => Number((nome.match(/\((\d{3,4})p\)/) || [])[1] || 0);
// tira "[Geo-blocked]", "(720p)" e os símbolos do Free-TV (Ⓖ bloqueio por país, Ⓨ YouTube, Ⓢ…)
const nomeLimpo = nome => nome.replace(/\s*\[[^\]]*\]/g, '').replace(/\s*\(\d{3,4}p\)/, '')
  .replace(/\s*[\u24B6-\u24E9]/g, '').trim();
// só toca com IP do país de origem
const bloqueioPorPais = nome => /\[Geo-blocked\]|\u24BC/i.test(nome);

// "NHKWorldJapan.jp@HD" e "@SD" são o mesmo canal em qualidades diferentes (viram
// reserva um do outro); "@Brazil" e "@Mexico" são versões regionais (ficam separadas)
const FEED_QUALIDADE = /^(sd|hd|fhd|uhd|4k)$/i;
function chaveCanal(c) {
  const id = c.attrs['tvg-id'];
  if (!id) return nomeLimpo(c.nome).toLowerCase();
  const [base, feed] = id.split('@');
  return (feed && !FEED_QUALIDADE.test(feed) ? id : base).toLowerCase();
}

// Junta os links do mesmo canal
function agrupar(itens) {
  const grupos = new Map();
  for (const c of itens) {
    const chave = chaveCanal(c);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(c);
  }
  const ids = new Set();
  return [...grupos.values()].map(links => {
    const c = links[0];
    const base = `x-${slug(c.attrs['tvg-id'] || nomeLimpo(c.nome))}`;
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    const grupo = links.find(l => l.grupoFixo)?.grupoFixo || (c.attrs['group-title'] || '').split(';')[0];
    return {
      id,
      nome: nomeLimpo(c.nome),
      grupo: !grupo || grupo === 'Undefined' ? 'Outros' : grupo,
      logo: links.find(l => l.attrs['tvg-logo'])?.attrs['tvg-logo'],
      tvgId: c.attrs['tvg-id'] || undefined,
      tipo: 'direto',
      // melhor resolução primeiro; o servidor troca para o próximo quando um falha
      origens: links.sort((a, b) => resolucao(b.nome) - resolucao(a.nome)).map(l => ({
        url: l.url, userAgent: l.userAgent, referrer: l.referrer, qualidade: resolucao(l.nome) || undefined,
        geo: bloqueioPorPais(l.nome) || undefined,
      })),
    };
  }).sort((a, b) => a.grupo.localeCompare(b.grupo) || a.nome.localeCompare(b.nome));
}

let rodando = null;

async function atualizar() {
  if (rodando) return rodando;
  rodando = (async () => {
    const cfg = fontes();
    const inicio = Date.now();
    console.log(`[atualizar] baixando ${cfg.listas.length} lista(s)…`);

    const brutos = [];
    // cada lista é uma URL ou { url, grupo }: o grupo fixo junta os canais por país/idioma
    for (const lista of cfg.listas) {
      // "categorias": só os canais dessas categorias do iptv-org (ex.: ["Movies", "Series"])
      const { url, grupo, categorias } = typeof lista === 'string' ? { url: lista } : lista;
      const so = categorias?.length ? new Set(categorias.map(c => c.toLowerCase())) : null;
      try {
        const itens = lerM3U(await baixar(url));
        console.log(`  ${url}: ${itens.length} links`);
        const filtrados = so
          ? itens.filter(i => (i.attrs['group-title'] || '').split(';').some(g => so.has(g.toLowerCase())))
          : itens;
        if (so) console.log(`    ${filtrados.length} nas categorias ${categorias.join(', ')}`);
        brutos.push(...filtrados.map(i => ({ ...i, grupoFixo: grupo })));
      } catch (e) {
        console.warn(`  ${e.message}`);
      }
    }
    if (!brutos.length) throw new Error('nenhuma lista baixada; lista anterior mantida');

    const excluir = new Set(cfg.excluirGrupos.map(g => g.toLowerCase()));
    const vistos = new Set();
    let suspeitas = 0;
    const candidatos = brutos.filter(c => {
      if (vistos.has(c.url)) return false; // a mesma URL aparece na lista do país e na do idioma
      vistos.add(c.url);
      const grupos = (c.attrs['group-title'] || '').split(';').map(g => g.toLowerCase());
      if (grupos.some(g => excluir.has(g))) return false;
      if (cfg.excluirNaoVinteQuatroHoras && /\[Not 24\/7\]/i.test(c.nome)) return false;
      if (naoTocavel(c.url)) return false;
      if (fonteSuspeita(c.url, cfg)) { suspeitas++; return false; }
      return true;
    });
    if (suspeitas) console.log(`[atualizar] ${suspeitas} links de fonte suspeita ignorados (excluirIpSolto/excluirHosts)`);

    let noAr = candidatos;
    if (cfg.testarStreams) {
      console.log(`[atualizar] testando ${candidatos.length} links (${cfg.simultaneos} por vez)…`);
      const ok = await emParalelo(candidatos, cfg.simultaneos, c => estaNoAr(c, cfg.timeoutTesteMs));
      noAr = candidatos.filter((_, i) => ok[i]);
    }

    const canais = agrupar(noAr);
    const saida = { atualizadoEm: new Date().toISOString(), canais };
    gravarJson(P.externos, saida);
    const reservas = canais.reduce((s, c) => s + c.origens.length - 1, 0);
    console.log(`[atualizar] ${canais.length} canais (${reservas} links reserva) de ${candidatos.length} ` +
      `${cfg.testarStreams ? 'testados' : 'sem teste'} (${Math.round((Date.now() - inicio) / 1000)} s)`);

    // guia de programação dos canais públicos (não trava a atualização se falhar)
    try {
      await epg.atualizarExterno(canais, cfg.epgExterno, config().epgIptvOrg, baixar);
    } catch (e) {
      console.warn(`[epg] ${e.message}`);
    }
    return saida;
  })();
  try {
    return await rodando;
  } finally {
    rodando = null;
  }
}

function precisaAtualizar() {
  try {
    return Date.now() - fs.statSync(P.externos).mtimeMs > fontes().atualizarACadaHoras * 3600_000;
  } catch {
    return true; // ainda não existe
  }
}

module.exports = { atualizar, precisaAtualizar, lerM3U, estaNoAr, fonteSuspeita, naoTocavel, agrupar, espelho, cabecalhos, baixar };
