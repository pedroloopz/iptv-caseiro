// Legenda automática em japonês: procura vídeos sem legenda japonesa (canais
// arquivo/pasta e biblioteca), confere se o áudio é japonês, transcreve com o
// Whisper e cria também a versão com furigana. Um vídeo por vez, em segundo plano.
// As legendas ficam em dados/transcricoes/ — a pasta dos seus vídeos não é tocada.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const legendas = require('./legendas');
const agenda = require('./agenda');
const biblioteca = require('./biblioteca');
const { sondar, rodar } = require('./midia');

const ESTADO = path.join(config.P.dados, 'transcricoes', 'estado.json');
const SCRIPTS = path.join(config.P.codigo, 'scripts');
const REPETIR_ERRO_MS = 24 * 3600_000;

let estado = null;          // chave (pasta) -> { status: ok|nao-japones|erro, video, em, erro? }
let fila = [];
let atual = null;
let rodando = false;
let avisouFurigana = false;

const lerEstado = () => (estado ??= config.lerJson(ESTADO, {}));
const salvar = () => config.gravarJson(ESTADO, estado);

function cfg() {
  return config.config().transcricao;
}

function executar(cmd, args, { timeoutMs = 6 * 3600_000 } = {}) {
  return new Promise((ok, falha) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out = (out + d).slice(-20_000); });
    p.stderr.on('data', d => { err = (err + d).slice(-20_000); });
    const timer = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.on('error', e => { clearTimeout(timer); falha(new Error(`${cmd}: ${e.code === 'ENOENT' ? 'não encontrado (instalado e no PATH?)' : e.message}`)); });
    p.on('exit', code => { clearTimeout(timer); ok({ code, out, err }); });
  });
}

const ultimaLinha = txt => txt.trim().split('\n').filter(Boolean).pop() || '';

// Todos os vídeos que o servidor conhece
function videosConhecidos() {
  const lista = new Set();
  for (const c of require('./canais').todos()) {
    if (c.local && (c.tipo === 'arquivo' || c.tipo === 'pasta')) agenda.arquivosDoCanal(c).forEach(v => lista.add(v));
  }
  for (const f of biblioteca.filmes()) lista.add(f.arquivo);
  for (const s of biblioteca.series()) s.episodios.forEach(e => lista.add(e.arquivo));
  return [...lista];
}

// Monta a fila com o que ainda precisa de legenda japonesa
async function varrer() {
  if (!cfg().ativo) return { fila: 0 };
  lerEstado();
  const novos = [];
  for (const video of videosConhecidos()) {
    const pasta = legendas.pastaAuto(video);
    if (!pasta || fila.some(f => f.video === video) || atual?.video === video) continue;
    const e = estado[path.basename(pasta)];
    if (e && (e.status !== 'erro' || Date.now() - e.em < REPETIR_ERRO_MS)) continue;
    let info;
    try { info = await sondar(video); } catch { continue; }
    if (!info.audios?.length) continue;
    const fontes = legendas.descobrir(video, info, config.config().idiomaLegendaPadrao);
    if (fontes.ja && !fontes.ja.auto) continue; // já tem legenda japonesa sua
    if (fontes.ja?.auto && (fontes.jf || !cfg().furigana)) continue;
    novos.push({ video, pasta, info });
  }
  fila.push(...novos);
  if (novos.length) console.log(`[transcrição] ${novos.length} vídeo(s) na fila`);
  processar();
  return { fila: fila.length };
}

// Faixa de áudio japonesa (pelo idioma marcado no arquivo); null = áudio em outro idioma
function escolherAudio(info) {
  const jp = info.audios.find(a => legendas.normalizarIdioma(a.idioma) === 'ja');
  if (jp) return { indice: jp.indice, conferir: false };
  const marcados = info.audios.filter(a => a.idioma !== 'und');
  if (marcados.length === info.audios.length) return null; // todos marcados e nenhum é japonês
  return { indice: (info.audios.find(a => a.idioma === 'und') || info.audios[0]).indice, conferir: true };
}

async function transcrever(item) {
  const c = cfg();
  const { video, pasta, info } = item;
  const chave = path.basename(pasta);
  const registrar = (status, extra = {}) => {
    estado[chave] = { status, video, em: Date.now(), ...extra };
    salvar();
  };
  fs.mkdirSync(pasta, { recursive: true });
  const srt = path.join(pasta, 'ja.srt');

  if (!fs.existsSync(srt)) {
    const audio = escolherAudio(info);
    if (!audio) return registrar('nao-japones', { detalhe: 'faixas de áudio marcadas em outro idioma' });
    const wav = path.join(pasta, 'audio.wav');
    try {
      // 16 kHz mono: o formato que o Whisper usa internamente
      await rodar('ffmpeg', ['-v', 'error', '-y', '-i', video, '-map', `0:a:${audio.indice}`, '-ac', '1', '-ar', '16000',
        '-c:a', 'pcm_s16le', wav], 2 * 3600_000);
      const inicio = Date.now();
      let r;
      if (c.motor === 'whisper.cpp') {
        if (audio.conferir && c.detectarIdioma !== false) {
          r = await executar(c.whisperCpp, ['-m', c.modelo, '-l', 'auto', '-dl', '-f', wav]);
          const idioma = ((r.out + r.err).match(/auto-detected language:\s*(\w+)/) || [])[1];
          if (idioma && idioma !== 'ja') return registrar('nao-japones', { detalhe: `áudio detectado: ${idioma}` });
        }
        r = await executar(c.whisperCpp, ['-m', c.modelo, '-l', 'ja', '-osrt', '-of', path.join(pasta, 'ja'), '-f', wav]);
      } else {
        const args = [path.join(SCRIPTS, 'transcrever.py'), wav, srt, '--modelo', c.modelo, '--idioma', 'ja', '--dispositivo', c.dispositivo];
        if (audio.conferir && c.detectarIdioma !== false) args.push('--detectar');
        r = await executar(c.python, args);
        if (r.code === 3) {
          const det = JSON.parse(ultimaLinha(r.out) || '{}');
          return registrar('nao-japones', { detalhe: `áudio detectado: ${det.idioma}` });
        }
      }
      if (r.code !== 0 || !fs.existsSync(srt)) throw new Error(ultimaLinha(r.err) || `código ${r.code}`);
      console.log(`[transcrição] ${path.basename(video)}: pronta em ${Math.round((Date.now() - inicio) / 1000)} s`);
    } finally {
      fs.rm(wav, { force: true }, () => {});
    }
  }

  if (c.furigana && !fs.existsSync(path.join(pasta, 'jf.srt'))) {
    const r = await executar(c.python, [path.join(SCRIPTS, 'furigana.py'), srt, path.join(pasta, 'jf.srt')], { timeoutMs: 10 * 60_000 });
    if (r.code !== 0 && !avisouFurigana) {
      avisouFurigana = true;
      console.warn(`[transcrição] furigana indisponível (${ultimaLinha(r.err)}); instale: pip install fugashi unidic-lite`);
    }
  }
  registrar('ok');
}

async function processar() {
  if (rodando) return;
  rodando = true;
  try {
    while (fila.length && cfg().ativo) {
      atual = fila.shift();
      console.log(`[transcrição] transcrevendo ${path.basename(atual.video)} (faltam ${fila.length})`);
      try {
        await transcrever(atual);
      } catch (e) {
        console.warn(`[transcrição] ${path.basename(atual.video)}: ${e.message}`);
        estado[path.basename(atual.pasta)] = { status: 'erro', video: atual.video, em: Date.now(), erro: e.message };
        salvar();
      }
    }
  } finally {
    atual = null;
    rodando = false;
  }
}

function resumo() {
  lerEstado();
  const valores = Object.values(estado);
  const conta = s => valores.filter(v => v.status === s).length;
  return {
    ativo: cfg().ativo, motor: cfg().motor, modelo: cfg().modelo,
    feitas: conta('ok'), naoJapones: conta('nao-japones'), erros: conta('erro'),
    fila: fila.length, atual: atual ? path.basename(atual.video) : null,
    ultimoErro: valores.filter(v => v.status === 'erro').sort((a, b) => b.em - a.em)[0]?.erro || null,
  };
}

// Erros voltam para a fila na hora (ex.: depois de instalar o que faltava)
function repetirErros() {
  lerEstado();
  for (const [k, v] of Object.entries(estado)) if (v.status === 'erro') delete estado[k];
  salvar();
  return varrer();
}

module.exports = { varrer, resumo, repetirErros, escolherAudio };
