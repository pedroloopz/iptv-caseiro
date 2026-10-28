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

// lê só o começo da resposta (até max bytes) e cancela o resto
async function lerInicio(r, max) {
  const leitor = r.body.getReader();
  const partes = [];
  let tam = 0;
  while (tam < max) {
    const { value, done } = await leitor.read();
    if (done) break;
    partes.push(value);
    tam += value.length;
  }
  leitor.cancel().catch(() => {});
  return Buffer.concat(partes.map(p => Buffer.from(p)));
}

// proteção contra cópia (FairPlay, Widevine, PlayReady): não toca fora do app oficial
const DRM = /METHOD=SAMPLE-AES|KEYFORMAT="(?:com\.apple\.streamingkeydelivery|urn:uuid:edef8ba9|urn:uuid:9a04f079)/i;
const primeiraMidia = (texto, base) => {
  const l = texto.split(/\r?\n/).find(x => x.trim() && !x.startsWith('#'));
  return l ? new URL(l.trim(), base).href : null;
};
// começo de MPEG-TS, MP4 fragmentado, ID3 ou AAC — não uma página de erro
function pareceVideo(buf, tipo) {
  if (/text\/html|application\/json/i.test(tipo)) return false;
  if (buf[0] === 0x47) return true;
  const caixa = buf.toString('latin1', 4, 8);
  if (['ftyp', 'styp', 'moof', 'sidx', 'moov'].includes(caixa)) return true;
  if (buf.toString('latin1', 0, 3) === 'ID3') return true;
  return buf[0] === 0xff && (buf[1] & 0xf0) === 0xf0;
}

// Testa o link de verdade: playlist -> qualidade -> começo do primeiro pedaço de vídeo.
// Canais bloqueados por país e com DRM costumam passar na playlist e falhar no vídeo.
async function estaNoAr(o, timeoutMs = 8000, profundo = true) {
  try {
    const pedir = (url, extra = {}) => fetch(url, { headers: { ...cabecalhos(o), ...extra }, signal: AbortSignal.timeout(timeoutMs) });
    let r = await pedir(o.url);
    if (!r.ok) return false;
    const tipo = r.headers.get('content-type') || '';
    const hls = /mpegurl/i.test(tipo) || /\.m3u8?(\?|$)/i.test(o.url) || /\.m3u8?(\?|$)/i.test(r.url);
    if (!hls) { await lerInicio(r, 1); return !/text\/html/i.test(tipo); } // outros formatos: basta responder
    let texto = (await lerInicio(r, 512 * 1024)).toString('utf8');
    if (!texto.startsWith('#EXTM3U')) return false;
    if (!profundo) return true;
    let base = r.url;
    for (let nivel = 0; nivel < 2 && /#EXT-X-STREAM-INF/.test(texto); nivel++) { // playlist principal -> uma qualidade
      const variante = primeiraMidia(texto, base);
      if (!variante) return false;
      r = await pedir(variante);
      if (!r.ok) return false;
      texto = (await lerInicio(r, 512 * 1024)).toString('utf8');
      base = r.url;
      if (!texto.startsWith('#EXTM3U')) return false;
    }
    if (DRM.test(texto)) return false;
    const seg = primeiraMidia(texto, base);
    if (!seg) return false;
    r = await pedir(seg, { Range: 'bytes=0-8191' });
    if (!r.ok) return false; // 403 (bloqueio por país), 404…
    const buf = await lerInicio(r, 16);
    // pedaço criptografado com AES-128 comum toca normalmente, mas os bytes parecem aleatórios
    return /METHOD=AES-128/.test(texto) ? buf.length > 0 : pareceVideo(buf, r.headers.get('content-type') || '');
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
const PAISES = {
  br: 'Brasil', pt: 'Portugal', jp: 'Japão', de: 'Alemanha', at: 'Áustria', ch: 'Suíça', li: 'Liechtenstein',
  lu: 'Luxemburgo', us: 'Estados Unidos', uk: 'Reino Unido', gb: 'Reino Unido', ie: 'Irlanda', ca: 'Canadá',
  au: 'Austrália', nz: 'Nova Zelândia', za: 'África do Sul', in: 'Índia', sg: 'Singapura', ph: 'Filipinas',
  ao: 'Angola', mz: 'Moçambique', cv: 'Cabo Verde', gw: 'Guiné-Bissau', st: 'São Tomé e Príncipe', tl: 'Timor-Leste',
  mo: 'Macau', es: 'Espanha', fr: 'França', it: 'Itália', nl: 'Holanda', be: 'Bélgica', pl: 'Polônia',
  mx: 'México', ar: 'Argentina', cl: 'Chile', co: 'Colômbia', uy: 'Uruguai', py: 'Paraguai', pe: 'Peru',
  kr: 'Coreia do Sul', cn: 'China', hk: 'Hong Kong', tw: 'Taiwan', ru: 'Rússia', tr: 'Turquia', int: 'Internacional',
  se: 'Suécia', dk: 'Dinamarca', no: 'Noruega', fi: 'Finlândia', is: 'Islândia', bg: 'Bulgária', ro: 'Romênia',
  ua: 'Ucrânia', hu: 'Hungria', cz: 'República Tcheca', sk: 'Eslováquia', gr: 'Grécia', rs: 'Sérvia', hr: 'Croácia',
  si: 'Eslovênia', ba: 'Bósnia', al: 'Albânia', mk: 'Macedônia do Norte', lt: 'Lituânia', lv: 'Letônia', ee: 'Estônia',
  mt: 'Malta', cy: 'Chipre', il: 'Israel', ae: 'Emirados Árabes', sa: 'Arábia Saudita', qa: 'Catar', eg: 'Egito',
  ng: 'Nigéria', ke: 'Quênia', gh: 'Gana', my: 'Malásia', id: 'Indonésia', th: 'Tailândia', vn: 'Vietnã',
  pk: 'Paquistão', bd: 'Bangladesh', lk: 'Sri Lanka', jm: 'Jamaica', tt: 'Trinidad e Tobago', pr: 'Porto Rico',
  do: 'República Dominicana', ve: 'Venezuela', ec: 'Equador', bo: 'Bolívia', cr: 'Costa Rica', pa: 'Panamá',
  gt: 'Guatemala', hn: 'Honduras', sv: 'El Salvador', ni: 'Nicarágua', cu: 'Cuba', ma: 'Marrocos', dz: 'Argélia',
  tn: 'Tunísia', ir: 'Irã', iq: 'Iraque', af: 'Afeganistão', kz: 'Cazaquistão', by: 'Belarus', md: 'Moldávia',
  ge: 'Geórgia', am: 'Armênia', az: 'Azerbaijão', np: 'Nepal', mm: 'Mianmar', kh: 'Camboja', mn: 'Mongólia',
  cm: 'Camarões', na: 'Namíbia', sx: 'São Martinho', uz: 'Uzbequistão',
};
// "Globo.br@SD" -> "Brasil"; sem tvg-id -> null
function paisDe(tvgId) {
  const cod = (tvgId || '').split('@')[0].split('.').pop().toLowerCase();
  if (!cod || cod === (tvgId || '').split('@')[0].toLowerCase()) return null;
  return PAISES[cod] || cod.toUpperCase();
}

function agrupar(itens, porPais = false) {
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
    // grupo: o fixo da lista; senão o país do canal (grupoPorPais); senão a categoria do iptv-org
    const pais = porPais && paisDe(links.find(l => l.attrs['tvg-id'])?.attrs['tvg-id']);
    const grupo = links.find(l => l.grupoFixo)?.grupoFixo || (porPais ? pais || 'Outros países' : (c.attrs['group-title'] || '').split(';')[0]);
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
      // "nomes": só os canais cujo nome bate com o texto (expressão regular, ex.: "UFC|Fight")
      const { url, grupo, categorias, nomes } = typeof lista === 'string' ? { url: lista } : lista;
      const so = categorias?.length ? new Set(categorias.map(c => c.toLowerCase())) : null;
      let nomeOk = null;
      if (nomes) {
        try { nomeOk = new RegExp(nomes, 'i'); } catch (e) { console.warn(`  "nomes" inválido em ${url}: ${e.message}`); continue; }
      }
      try {
        const itens = lerM3U(await baixar(url));
        console.log(`  ${url}: ${itens.length} links`);
        const filtrados = itens
          .filter(i => !so || (i.attrs['group-title'] || '').split(';').some(g => so.has(g.toLowerCase())))
          .filter(i => !nomeOk || nomeOk.test(i.nome));
        if (so || nomeOk) console.log(`    ${filtrados.length} depois dos filtros${so ? ` (categorias ${categorias.join(', ')})` : ''}${nomeOk ? ` (nomes /${nomes}/)` : ''}`);
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
      const ok = await emParalelo(candidatos, cfg.simultaneos, c => estaNoAr(c, cfg.timeoutTesteMs, cfg.testeCompleto !== false));
      noAr = candidatos.filter((_, i) => ok[i]);
    }

    const canais = agrupar(noAr, cfg.grupoPorPais);
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

module.exports = { paisDe, pareceVideo, atualizar, precisaAtualizar, lerM3U, estaNoAr, fonteSuspeita, naoTocavel, agrupar, espelho, cabecalhos, baixar };
