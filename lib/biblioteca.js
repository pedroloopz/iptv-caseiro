// Biblioteca sob demanda: biblioteca/filmes/** e biblioteca/series/<Série>/**.
// Capa, sinopse e nota vêm do TMDB se houver tmdbApiKey no config.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { listarVideos, tituloDoArquivo } = require('./midia');

const CACHE_TMDB = path.join(config.P.dados, 'tmdb.json');
let estado = { filmes: [], series: [], porId: new Map(), porNum: new Map(), lidoEm: 0 };
let tmdb = null;

const hash = s => crypto.createHash('sha1').update(s).digest('hex');
const numId = s => parseInt(hash(s).slice(0, 7), 16);

// "Nome do Filme (2019)" / "Nome.do.Filme.2019.1080p" -> { titulo, ano }
function tituloEAno(arquivo) {
  const t = tituloDoArquivo(arquivo);
  const m = t.match(/^(.*?)[\s(]*((?:19|20)\d{2})\)?$/);
  return m && m[1].trim() ? { titulo: m[1].trim(), ano: Number(m[2]) } : { titulo: t, ano: null };
}

// S01E02, 1x02, "Temporada 2/…Episódio 05", ou o número no nome
function temporadaEpisodio(rel, ordem) {
  const nome = rel.replace(/\\/g, '/');
  let m = nome.match(/s(\d{1,2})\s*e(\d{1,3})/i) || nome.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (m) return { temporada: Number(m[1]), episodio: Number(m[2]) };
  const temp = nome.match(/(?:temporada|season|temp)[\s._-]*(\d{1,2})/i);
  const base = path.basename(nome).replace(/\.[^.]+$/, '');
  m = base.match(/(?:ep(?:is[oó]dio)?|e|#)[\s._-]*(\d{1,3})/i) || base.match(/(\d{1,3})(?!.*\d)/);
  return { temporada: temp ? Number(temp[1]) : 1, episodio: m ? Number(m[1]) : ordem + 1 };
}

function escanear() {
  const raiz = config.pastaBiblioteca();
  const pFilmes = path.join(raiz, 'filmes');
  const pSeries = path.join(raiz, 'series');
  const filmes = [];
  const series = [];

  if (fs.existsSync(pFilmes)) {
    for (const arq of listarVideos(pFilmes, true)) {
      const rel = path.relative(pFilmes, arq);
      const pasta = path.dirname(rel);
      const { titulo, ano } = tituloEAno(arq);
      const id = `f-${hash(`filme|${rel}`).slice(0, 12)}`;
      filmes.push({ id, numId: numId(id), tipo: 'filme', titulo, ano, arquivo: arq,
        categoria: pasta === '.' ? 'Filmes' : pasta.split(path.sep)[0],
        ext: path.extname(arq).slice(1).toLowerCase(), adicionado: Math.round(fs.statSync(arq).mtimeMs / 1000) });
    }
  }

  if (fs.existsSync(pSeries)) {
    for (const ent of fs.readdirSync(pSeries, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const pasta = path.join(pSeries, ent.name);
      const sid = `s-${hash(`serie|${ent.name}`).slice(0, 12)}`;
      const episodios = listarVideos(pasta, true).map((arq, i) => {
        const rel = path.relative(pasta, arq);
        const id = `e-${hash(`ep|${ent.name}|${rel}`).slice(0, 12)}`;
        return { id, numId: numId(id), tipo: 'episodio', serieId: sid, ...temporadaEpisodio(rel, i),
          titulo: tituloDoArquivo(arq), arquivo: arq, ext: path.extname(arq).slice(1).toLowerCase(),
          adicionado: Math.round(fs.statSync(arq).mtimeMs / 1000) };
      }).sort((a, b) => a.temporada - b.temporada || a.episodio - b.episodio);
      if (!episodios.length) continue;
      const { titulo, ano } = tituloEAno(ent.name);
      series.push({ id: sid, numId: numId(sid), tipo: 'serie', titulo, ano, pasta, categoria: 'Séries', episodios,
        adicionado: Math.max(...episodios.map(e => e.adicionado)) });
    }
  }

  const tudo = [...filmes, ...series, ...series.flatMap(s => s.episodios)];
  estado = { filmes, series, porId: new Map(tudo.map(x => [x.id, x])), porNum: new Map(tudo.map(x => [x.numId, x])), lidoEm: Date.now() };
  aplicarTmdb();
  enriquecer().catch(e => console.warn(`[tmdb] ${e.message}`));
  return estado;
}

// ---------- TMDB (opcional) ----------

function aplicarTmdb() {
  tmdb ??= config.lerJson(CACHE_TMDB, {});
  for (const x of [...estado.filmes, ...estado.series]) {
    const m = tmdb[chaveTmdb(x)];
    if (m) x.meta = m;
  }
}
const chaveTmdb = x => `${x.tipo}|${x.titulo.toLowerCase()}|${x.ano || ''}`;

let enriquecendo = false;
async function enriquecer() {
  const chave = config.config().tmdbApiKey;
  if (!chave || enriquecendo) return;
  enriquecendo = true;
  let novos = 0;
  try {
    for (const x of [...estado.filmes, ...estado.series]) {
      const k = chaveTmdb(x);
      if (tmdb[k] !== undefined) continue;
      const tipo = x.tipo === 'filme' ? 'movie' : 'tv';
      const q = new URLSearchParams({ api_key: chave, query: x.titulo, language: 'pt-BR' });
      if (x.ano) q.set(tipo === 'movie' ? 'year' : 'first_air_date_year', x.ano);
      const r = await fetch(`https://api.themoviedb.org/3/search/${tipo}?${q}`, { signal: AbortSignal.timeout(15_000) });
      if (r.status === 401) throw new Error('tmdbApiKey inválida');
      if (!r.ok) continue;
      const res = (await r.json()).results?.[0];
      tmdb[k] = res ? {
        tmdbId: res.id,
        nome: res.title || res.name,
        sinopse: res.overview,
        nota: res.vote_average,
        lancamento: res.release_date || res.first_air_date,
        capa: res.poster_path ? `https://image.tmdb.org/t/p/w500${res.poster_path}` : null,
        fundo: res.backdrop_path ? `https://image.tmdb.org/t/p/w1280${res.backdrop_path}` : null,
      } : null;
      novos++;
      await new Promise(r => setTimeout(r, 250)); // respeita o limite da API
    }
  } finally {
    enriquecendo = false;
    if (novos) {
      config.gravarJson(CACHE_TMDB, tmdb);
      aplicarTmdb();
      console.log(`[tmdb] ${novos} títulos consultados`);
    }
  }
}

module.exports = {
  escanear,
  filmes: () => estado.filmes,
  series: () => estado.series,
  porId: id => estado.porId.get(id),
  porNum: n => estado.porNum.get(Number(n)),
  lidoEm: () => estado.lidoEm,
  temporadaEpisodio, tituloEAno,
};
