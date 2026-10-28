// Informações dos vídeos via ffprobe (duração, legendas embutidas), com cache em
// disco para não reler arquivos grandes a cada início de canal.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { P, lerJson, gravarJson } = require('./config');

const CACHE = path.join(P.dados, 'midia-cache.json');
const VIDEO = /\.(mp4|mkv|avi|mov|webm|m4v|ts|mpg|mpeg|wmv|flv)$/i;
// legendas em imagem (Blu-ray/DVD) não viram texto
const LEGENDA_TEXTO = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

let cache = null;
let gravacaoPendente = null;

function rodar(cmd, args, timeoutMs = 60_000) {
  return new Promise((ok, falha) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return falha(new Error(`${cmd}: ${(stderr || err.message).toString().trim().split('\n').pop()}`));
      ok(stdout);
    });
  });
}

const chave = (arquivo, st) => `${arquivo}|${st.size}|${Math.round(st.mtimeMs)}`;

async function sondar(arquivo) {
  cache ??= lerJson(CACHE, {});
  const st = fs.statSync(arquivo);
  const k = chave(arquivo, st);
  if (cache[k]) return cache[k];
  const json = JSON.parse(await rodar('ffprobe', ['-v', 'error', '-print_format', 'json',
    '-show_entries', 'format=duration:stream=index,codec_type,codec_name,height:stream_tags=language,title', arquivo]));
  const streams = json.streams || [];
  const info = {
    duracao: Number(json.format?.duration) || 0,
    altura: streams.find(s => s.codec_type === 'video')?.height || 0,
    audios: streams.filter(s => s.codec_type === 'audio').map((s, i) => ({ indice: i, idioma: s.tags?.language || 'und' })),
  };
  // o índice relativo (0:s:N) conta todas as legendas, inclusive as de imagem
  const todas = streams.filter(s => s.codec_type === 'subtitle');
  info.legendas = todas.map((s, i) => ({ s, i })).filter(({ s }) => LEGENDA_TEXTO.has(s.codec_name))
    .map(({ s, i }) => ({ indice: i, idioma: s.tags?.language || 'und', titulo: s.tags?.title || '' }));
  cache[k] = info;
  clearTimeout(gravacaoPendente);
  gravacaoPendente = setTimeout(() => {
    // descarta entradas de arquivos que não existem mais
    for (const kk of Object.keys(cache)) if (!fs.existsSync(kk.split('|')[0])) delete cache[kk];
    gravarJson(CACHE, cache);
  }, 2000);
  return info;
}

// Lista vídeos de uma pasta (recursivo opcional) em ordem natural: ep2 antes de ep10
function listarVideos(dir, recursivo = false) {
  const saida = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory() && recursivo) saida.push(...listarVideos(p, true));
    else if (ent.isFile() && VIDEO.test(ent.name) && !ent.name.startsWith('.')) saida.push(p);
  }
  return saida.sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
}

// "Meu.Filme.2019.1080p.BluRay" -> "Meu Filme 2019"
function tituloDoArquivo(arquivo) {
  return path.basename(arquivo).replace(/\.[^.]+$/, '')
    .replace(/[._]+/g, ' ')
    .replace(/\[[^\]]*\]|\([^)]*(?:p|rip|web|x26\d)[^)]*\)/gi, ' ')
    .replace(/\b(2160p|1080p|720p|480p|bluray|brrip|webrip|web-dl|webdl|hdtv|x264|x265|h264|hevc|aac|dual|dublado|legendado)\b.*$/i, '')
    .replace(/\s+/g, ' ').trim() || path.basename(arquivo);
}

module.exports = { sondar, rodar, listarVideos, tituloDoArquivo, VIDEO };
