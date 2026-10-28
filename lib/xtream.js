// API no padrão Xtream Codes: TiviMate, IPTV Smarters, XCIPTV etc. mostram canais,
// filmes e séries (com capa e sinopse) usando só servidor + usuário + senha.
const canais = require('./canais');
const biblioteca = require('./biblioteca');

const cat = nome => canais.numId(`cat|${nome}`) % 1_000_000;

function categorias(itens, grupoDe) {
  const vistos = new Map();
  for (const x of itens) {
    const g = grupoDe(x);
    if (!vistos.has(g)) vistos.set(g, { category_id: String(cat(g)), category_name: g, parent_id: 0 });
  }
  return [...vistos.values()];
}

const filtrarCat = (itens, grupoDe, id) => (id ? itens.filter(x => String(cat(grupoDe(x))) === String(id)) : itens);

function infoFilme(f) {
  const m = f.meta || {};
  return {
    name: m.nome || f.titulo, o_name: f.titulo, cover_big: m.capa || '', movie_image: m.capa || '',
    backdrop_path: m.fundo ? [m.fundo] : [], plot: m.sinopse || '', description: m.sinopse || '',
    rating: m.nota ? String(m.nota) : '', releasedate: m.lancamento || (f.ano ? String(f.ano) : ''),
    tmdb_id: m.tmdbId ? String(m.tmdbId) : '', duration: '', genre: '',
  };
}

// usuario: o autenticado; base: "http://host:porta"
function api(url, usuario, base) {
  const acao = url.searchParams.get('action');
  const idCat = url.searchParams.get('category_id');
  const vis = canais.visiveis();
  const grupoFilme = f => f.categoria;

  switch (acao) {
    case null:
    case '': {
      const u = new URL(base);
      return {
        user_info: { username: usuario.usuario, password: usuario.senha, auth: 1, status: 'Active', exp_date: null,
          is_trial: '0', active_cons: '0', created_at: '0', max_connections: '10', allowed_output_formats: ['m3u8'] },
        server_info: { url: u.hostname, port: u.port || (u.protocol === 'https:' ? '443' : '80'),
          https_port: u.protocol === 'https:' ? (u.port || '443') : '', server_protocol: u.protocol.replace(':', ''),
          rtmp_port: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          timestamp_now: Math.floor(Date.now() / 1000), time_now: new Date().toISOString().replace('T', ' ').slice(0, 19) },
      };
    }
    case 'get_live_categories': return categorias(vis, canais.grupoDe);
    case 'get_live_streams':
      return filtrarCat(vis, canais.grupoDe, idCat).map(c => ({
        num: c.numero, name: c.nome, stream_type: 'live', stream_id: c.numId, stream_icon: c.logo || '',
        epg_channel_id: c.id, added: '0', category_id: String(cat(canais.grupoDe(c))), custom_sid: '',
        tv_archive: 0, direct_source: '', tv_archive_duration: 0,
      }));
    case 'get_vod_categories': return categorias(biblioteca.filmes(), grupoFilme);
    case 'get_vod_streams':
      return filtrarCat(biblioteca.filmes(), grupoFilme, idCat).map((f, i) => ({
        num: i + 1, name: f.meta?.nome || f.titulo, stream_type: 'movie', stream_id: f.numId,
        stream_icon: f.meta?.capa || '', rating: f.meta?.nota ? String(f.meta.nota) : '', rating_5based: (f.meta?.nota || 0) / 2,
        added: String(f.adicionado), category_id: String(cat(f.categoria)), container_extension: f.ext,
        custom_sid: '', direct_source: '',
      }));
    case 'get_vod_info': {
      const f = biblioteca.porNum(url.searchParams.get('vod_id'));
      if (!f || f.tipo !== 'filme') return {};
      return { info: infoFilme(f), movie_data: { stream_id: f.numId, name: f.titulo, added: String(f.adicionado),
        category_id: String(cat(f.categoria)), container_extension: f.ext, custom_sid: '', direct_source: '' } };
    }
    case 'get_series_categories': return categorias(biblioteca.series(), s => s.categoria);
    case 'get_series':
      return filtrarCat(biblioteca.series(), s => s.categoria, idCat).map((s, i) => ({
        num: i + 1, name: s.meta?.nome || s.titulo, series_id: s.numId, cover: s.meta?.capa || '',
        plot: s.meta?.sinopse || '', cast: '', director: '', genre: '', releaseDate: s.meta?.lancamento || '',
        last_modified: String(s.adicionado), rating: s.meta?.nota ? String(s.meta.nota) : '',
        rating_5based: (s.meta?.nota || 0) / 2, backdrop_path: s.meta?.fundo ? [s.meta.fundo] : [],
        youtube_trailer: '', episode_run_time: '', category_id: String(cat(s.categoria)),
      }));
    case 'get_series_info': {
      const s = biblioteca.porNum(url.searchParams.get('series_id'));
      if (!s || s.tipo !== 'serie') return {};
      const episodes = {};
      for (const e of s.episodios) {
        (episodes[e.temporada] ||= []).push({
          id: String(e.numId), episode_num: e.episodio, title: e.titulo, container_extension: e.ext,
          info: {}, custom_sid: '', added: String(e.adicionado), season: e.temporada, direct_source: '',
        });
      }
      return {
        seasons: Object.keys(episodes).map(n => ({ season_number: Number(n), name: `Temporada ${n}`,
          episode_count: episodes[n].length, cover: s.meta?.capa || '' })),
        info: { name: s.meta?.nome || s.titulo, cover: s.meta?.capa || '', plot: s.meta?.sinopse || '',
          rating: s.meta?.nota ? String(s.meta.nota) : '', releaseDate: s.meta?.lancamento || '', category_id: String(cat(s.categoria)) },
        episodes,
      };
    }
    case 'get_short_epg':
    case 'get_simple_data_table':
      return { epg_listings: [] }; // os apps usam o xmltv.php para o guia
    default:
      return { erro: `ação desconhecida: ${acao}` };
  }
}

// /live/<u>/<s>/<id>.m3u8 | /movie/<u>/<s>/<id>.<ext> | /series/<u>/<s>/<id>.<ext>
function resolverCaminho(pathname) {
  const m = pathname.match(/^\/(live|movie|series)\/([^/]+)\/([^/]+)\/(\d+)(?:\.(\w+))?$/);
  if (!m) return null;
  const [, tipo, usuario, senha, id] = m;
  const item = tipo === 'live' ? canais.porNum(id) : biblioteca.porNum(id);
  return { tipo, usuario: decodeURIComponent(usuario), senha: decodeURIComponent(senha), item };
}

module.exports = { api, resolverCaminho };
