// Legendas: descobre arquivos .srt/.ass/.vtt ao lado do vídeo e faixas embutidas
// (mkv), converte tudo para WebVTT e gera os pedaços de legenda das transmissões.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { P } = require('./config');
const { rodar } = require('./midia');

const PASTA = path.join(P.dados, 'legendas');
const EXT = ['.srt', '.ass', '.ssa', '.vtt'];

const ISO3 = { jpn: 'ja', por: 'pt', pob: 'pt', eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de',
  ita: 'it', kor: 'ko', chi: 'zh', zho: 'zh', rus: 'ru' };
const NOMES = { jf: '日本語 (ふりがな)', ja: '日本語', pt: 'Português', en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch',
  it: 'Italiano', ko: '한국어', zh: '中文', ru: 'Русский' };

function normalizarIdioma(i) {
  const s = String(i || '').toLowerCase().replace(/_/g, '-');
  if (s === 'pt-br' || s === 'ptbr') return 'pt';
  // faixa japonesa com a leitura em hiragana: Ep01.ja-furigana.srt
  if (['jf', 'ja-furigana', 'furigana', 'ja-hrkt', 'ja-kana'].includes(s)) return 'jf';
  const base = s.split('-')[0];
  return ISO3[base] || (/^[a-z]{2}$/.test(base) ? base : null);
}
const nomeIdioma = i => NOMES[i] || i.toUpperCase();
// código de idioma para players (BCP 47): a furigana é japonês escrito em kana
const codigoIdioma = i => (i === 'jf' ? 'ja-Hrkt' : i);

// transcrições automáticas ficam em dados/transcricoes/<id do arquivo>/ (nunca na pasta dos seus vídeos)
function pastaAuto(video) {
  try {
    const st = fs.statSync(video);
    return path.join(P.dados, 'transcricoes', crypto.createHash('sha1').update(`${video}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 16));
  } catch {
    return null;
  }
}

// Fontes de legenda de um vídeo: { pt: {arquivo}, ja: {embutida: 2} }
// "Ep01.ja.srt" -> ja; "Ep01.srt" (sem idioma) -> idiomaPadrao
function descobrir(video, info, idiomaPadrao = 'pt') {
  const fontes = {};
  const base = path.basename(video).replace(/\.[^.]+$/, '');
  const dir = path.dirname(video);
  let arquivos = [];
  try { arquivos = fs.readdirSync(dir); } catch {}
  for (const f of arquivos) {
    const ext = path.extname(f).toLowerCase();
    if (!EXT.includes(ext) || !f.startsWith(base)) continue;
    const meio = f.slice(base.length, -ext.length); // "", ".ja", ".pt-BR", ".forced"…
    if (meio && !meio.startsWith('.')) continue;     // "Ep01b.srt" não é de "Ep01"
    const partes = meio.split('.').filter(Boolean);
    const idioma = partes.length ? partes.map(normalizarIdioma).find(Boolean) : normalizarIdioma(idiomaPadrao);
    if (idioma && !fontes[idioma]) fontes[idioma] = { arquivo: path.join(dir, f) };
  }
  for (const l of info?.legendas || []) {
    const idioma = normalizarIdioma(l.idioma) || (l.idioma === 'und' ? normalizarIdioma(idiomaPadrao) : null);
    if (idioma && !fontes[idioma]) fontes[idioma] = { embutida: l.indice };
  }
  // legenda feita por você sempre ganha da automática
  const auto = pastaAuto(video);
  for (const idioma of ['ja', 'jf']) {
    const f = auto && path.join(auto, `${idioma}.srt`);
    if (f && !fontes[idioma] && fs.existsSync(f)) fontes[idioma] = { arquivo: f, auto: true };
  }
  return fontes;
}

// Legendas brasileiras antigas costumam vir em Windows-1252, não UTF-8
function pareceUtf8(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}

const conversoes = new Map(); // promessas em andamento/prontas, por arquivo de saída

// Converte qualquer fonte para .vtt (cacheado em dados/legendas) e devolve o caminho
function paraVtt(video, fonte) {
  const origem = fonte.arquivo || video;
  const st = fs.statSync(origem);
  const id = crypto.createHash('sha1').update(`${origem}|${st.size}|${st.mtimeMs}|${fonte.embutida ?? ''}`).digest('hex').slice(0, 16);
  const saida = path.join(PASTA, `${id}.vtt`);
  if (conversoes.has(saida)) return conversoes.get(saida);
  const p = (async () => {
    if (fs.existsSync(saida)) return saida;
    fs.mkdirSync(PASTA, { recursive: true });
    const args = ['-v', 'error', '-y'];
    if (fonte.arquivo && !fonte.arquivo.endsWith('.vtt') && !pareceUtf8(fs.readFileSync(fonte.arquivo))) {
      args.push('-sub_charenc', 'CP1252');
    }
    args.push('-i', origem);
    if (fonte.embutida !== undefined) args.push('-map', `0:s:${fonte.embutida}`);
    args.push('-c:s', 'webvtt', `${saida}.tmp.vtt`);
    await rodar('ffmpeg', args, 10 * 60_000);
    fs.renameSync(`${saida}.tmp.vtt`, saida);
    return saida;
  })();
  p.catch(() => conversoes.delete(saida));
  conversoes.set(saida, p);
  return p;
}

function tempo(t) { // "01:02:03.456" ou "02:03.456" -> segundos
  const partes = t.trim().replace(',', '.').split(':').map(Number);
  return partes.reduce((acc, n) => acc * 60 + n, 0);
}
function formatar(seg) {
  const ms = Math.max(0, Math.round(seg * 1000));
  const p = (n, d = 2) => String(n).padStart(d, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
}

function lerVtt(texto) {
  const cues = [];
  for (const bloco of texto.replace(/\r/g, '').split(/\n\n+/)) {
    const linhas = bloco.split('\n');
    const i = linhas.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [ini, resto] = linhas[i].split('-->');
    const fim = resto.trim().split(/\s+/)[0];
    const textoCue = linhas.slice(i + 1).join('\n').trim();
    if (textoCue) cues.push({ ini: tempo(ini), fim: tempo(fim), texto: textoCue });
  }
  return cues;
}

const cuesCache = new Map();
async function cues(video, fonte) {
  const vtt = await paraVtt(video, fonte);
  if (!cuesCache.has(vtt)) {
    if (cuesCache.size > 50) cuesCache.delete(cuesCache.keys().next().value);
    cuesCache.set(vtt, lerVtt(fs.readFileSync(vtt, 'utf8')));
  }
  return cuesCache.get(vtt);
}

// Pedaço de legenda HLS: só as falas que aparecem entre [ini, fim) do vídeo, com o
// mapa que alinha o tempo do vídeo (PTS do MPEG-TS) ao tempo do arquivo
function pedacoVtt(lista, ini, fim, ptsInicio, localInicio) {
  const linhas = ['WEBVTT', `X-TIMESTAMP-MAP=MPEGTS:${ptsInicio},LOCAL:${formatar(localInicio)}`, ''];
  for (const c of lista) {
    if (c.fim <= ini || c.ini >= fim) continue;
    linhas.push(`${formatar(c.ini)} --> ${formatar(c.fim)}`, c.texto, '');
  }
  return linhas.join('\n');
}

module.exports = { descobrir, paraVtt, cues, lerVtt, pedacoVtt, normalizarIdioma, nomeIdioma, codigoIdioma, pastaAuto, formatar, pareceUtf8 };
