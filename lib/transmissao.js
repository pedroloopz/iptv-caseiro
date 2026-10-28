// Transmissão ao vivo de um canal local. O ffmpeg só produz os segmentos de vídeo
// (um processo por vídeo da programação); quem monta as playlists HLS é o servidor:
// playlist principal com as qualidades, faixas de legenda WebVTT por idioma e a
// emenda entre um episódio e outro (EXT-X-DISCONTINUITY e sua contagem).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { P } = require('./config');
const agenda = require('./agenda');
const legendas = require('./legendas');
const cod = require('./codificador');
const { rodar } = require('./midia');

function lerPlaylist(arquivo) {
  let texto;
  try { texto = fs.readFileSync(arquivo, 'utf8'); } catch { return null; }
  const seq = Number((texto.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] || 0);
  const segs = [];
  let dur = null;
  for (const l of texto.split('\n')) {
    if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l && !l.startsWith('#') && dur !== null) { segs.push({ dur, uri: l.trim() }); dur = null; }
  }
  return { seq, segs };
}

class Transmissao {
  constructor(c, cfg) {
    this.c = c;
    this.cfg = cfg;
    this.dir = path.join(P.hls, c.id);
    this.janela = cfg.janelaSegmentos;
    this.qs = cod.qualidades(c, cfg);
    this.linha = [];        // segmentos publicados: { seq, dur, run, uri, local, disc }
    this.seq = 0;
    this.descBase = 0;      // emendas que já saíram da linha
    this.runs = [];         // processos cujos segmentos ainda vão ser publicados, em ordem
    this.consumidos = [];   // processos já publicados (aguardando limpeza)
    this.nRun = 0;
    this.falhasSeguidas = 0;
    this.idiomas = [];
    this.parado = false;
    this.erro = null;
    this.ultimoAcesso = Date.now();
  }

  async iniciar() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    const { c, cfg } = this;
    if (c.tipo === 'arquivo' || c.tipo === 'pasta') {
      this.itens = await agenda.montar(c);
      if (!this.itens.length) throw new Error(`nenhum vídeo tocável em ${c.origem}`);
      const padrao = c.idiomaLegenda || cfg.idiomaLegendaPadrao;
      const todos = new Set();
      for (const it of this.itens) {
        it.legendas = legendas.descobrir(it.video, it.info, padrao);
        if (c.legenda) it.legendas[legendas.normalizarIdioma(padrao) || 'pt'] = { arquivo: path.resolve(P.raiz, c.legenda) };
        Object.keys(it.legendas).forEach(i => todos.add(i));
      }
      const gravada = legendas.normalizarIdioma(c.legendaGravada);
      const preferido = legendas.normalizarIdioma(padrao);
      this.idiomas = [...todos].filter(i => i !== gravada)
        .sort((a, b) => (b === preferido) - (a === preferido) || a.localeCompare(b));
      const pos = agenda.posicao(this.itens);
      this.proximo = pos.indice;
      await this.lancar(pos.offset);
    } else {
      this.lancarContinuo();
    }
    this.timer = setInterval(() => this.ler(), 500);
  }

  novoRun(item, offset) {
    const n = this.nRun++;
    const dir = path.join(this.dir, `r${n}`);
    fs.mkdirSync(dir, { recursive: true });
    const run = { n, dir, item, offset, local: offset, lidos: 0, pts: null, proc: null, fim: false };
    this.runs.push(run);
    return run;
  }

  spawn(run, args) {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args],
      { cwd: run.dir, stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', d => process.stderr.write(`[${this.c.id}] ${d}`));
    run.proc = proc;
    return proc;
  }

  // Próximo vídeo da programação, começando em offset segundos
  async lancar(offset = 0) {
    if (this.parado) return;
    const { c, cfg } = this;
    const item = this.itens[this.proximo];
    this.proximo = (this.proximo + 1) % this.itens.length;
    const run = this.novoRun(item, offset);

    let filtroBase = '';
    const gravada = legendas.normalizarIdioma(c.legendaGravada);
    if (gravada && item.legendas[gravada]) {
      try {
        fs.copyFileSync(await legendas.paraVtt(item.video, item.legendas[gravada]), path.join(run.dir, 'gravada.vtt'));
        // o filtro de legenda usa o tempo do arquivo; com -ss o vídeo recomeça do zero, então desloca e volta
        filtroBase = `setpts=PTS+${offset.toFixed(3)}/TB,subtitles=gravada.vtt,setpts=PTS-STARTPTS`;
      } catch (e) {
        console.warn(`[${c.id}] legenda gravada indisponível: ${e.message}`);
      }
    }
    // já prepara as legendas selecionáveis para a primeira requisição não esperar
    for (const i of this.idiomas) if (item.legendas[i]) legendas.paraVtt(item.video, item.legendas[i]).catch(() => {});

    console.log(`[${c.id}] tocando ${path.basename(item.video)}${offset > 1 ? ` a partir de ${legendas.formatar(offset).slice(0, 8)}` : ''}`);
    const proc = this.spawn(run, [...cod.argsGlobais(cfg), '-re', '-ss', offset.toFixed(3), '-i', item.video,
      ...cod.argsSaidas({ cfg, c, dir: '.', qs: this.qs, filtroBase })]);

    // começa o próximo vídeo um pouco antes do fim deste, para a troca não travar o player
    const restante = item.duracao - offset;
    run.timerProximo = setTimeout(() => {
      if (!this.parado && this.runs.at(-1) === run) this.lancar(0);
    }, Math.max(0, (restante - cfg.segundosSegmento - 3) * 1000));

    proc.on('exit', code => {
      run.fim = true;
      if (this.parado) return;
      if (code === 0 || run.lidos > 0) this.falhasSeguidas = 0;
      else if (++this.falhasSeguidas >= this.itens.length) {
        this.erro = 'nenhum vídeo da programação pôde ser tocado';
        return this.aoErro?.(this.erro);
      }
      if (this.runs.at(-1) === run) {
        clearTimeout(run.timerProximo);
        setTimeout(() => this.lancar(0), code === 0 ? 0 : 1000);
      }
    });
  }

  // Sinal de teste e links externos: um ffmpeg só, até a fonte cair
  lancarContinuo() {
    const { c, cfg } = this;
    const run = this.novoRun(null, 0);
    let entrada, audio = '0:a:0?';
    if (c.tipo === 'teste') {
      entrada = ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];
      audio = '1:a:0';
    } else if (c.tipo === 'url') {
      const rede = /^https?:/.test(c.origem)
        ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : [];
      entrada = [...rede, '-i', c.origem];
    } else {
      throw new Error(`tipo desconhecido: ${c.tipo}`);
    }
    const proc = this.spawn(run, [...cod.argsGlobais(cfg), ...entrada,
      ...cod.argsSaidas({ cfg, c, dir: '.', qs: this.qs, entradaAudio: audio })]);
    proc.on('exit', code => {
      run.fim = true;
      if (this.parado) return;
      this.erro = `ffmpeg encerrou (código ${code})`;
      this.aoErro?.(this.erro);
    });
  }

  // Segmentos prontos em TODAS as qualidades, a partir do índice absoluto 0 do processo
  disponiveis(run) {
    let n = Infinity;
    let q0 = null;
    for (let i = 0; i < this.qs.length; i++) {
      const pl = lerPlaylist(path.join(run.dir, `q${i}.m3u8`));
      if (!pl) return { n: 0, q0: null };
      n = Math.min(n, pl.seq + pl.segs.length);
      if (i === 0) q0 = pl;
    }
    return { n, q0 };
  }

  async lerPts(run, uri) {
    try {
      const out = await rodar('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_pts',
        '-of', 'csv=p=0', path.join(run.dir, uri)], 15_000);
      const pts = parseInt(out, 10);
      return Number.isFinite(pts) ? pts : 126000;
    } catch {
      return 126000; // padrão do muxer MPEG-TS do ffmpeg
    }
  }

  async ler() {
    if (this.lendo || this.parado) return;
    this.lendo = true;
    try {
      while (this.runs.length) {
        const run = this.runs[0];
        const terminou = run.fim; // lido antes da playlist: nada escrito depois disso se perde
        const { n, q0 } = this.disponiveis(run);
        while (run.lidos < n) {
          const seg = q0.segs[run.lidos - q0.seq];
          if (!seg) { run.lidos++; continue; } // atrasou demais e saiu da lista do ffmpeg
          if (run.pts === null) run.pts = await this.lerPts(run, seg.uri);
          this.linha.push({ seq: this.seq, dur: seg.dur, run, uri: seg.uri, local: run.local,
            disc: run.lidos === 0 && this.seq > 0 });
          this.seq++;
          run.local += seg.dur;
          run.lidos++;
        }
        if (!terminou) break;
        this.runs.shift();
        this.consumidos.push(run);
      }
      this.limpar();
    } catch (e) {
      console.error(`[${this.c.id}] ${e.message}`);
    } finally {
      this.lendo = false;
    }
  }

  limpar() {
    while (this.linha.length > this.janela + 4) {
      const s = this.linha.shift();
      if (s.disc) this.descBase++;
      for (let i = 0; i < this.qs.length; i++) {
        fs.rm(path.join(s.run.dir, s.uri.replace(/^q0_/, `q${i}_`)), { force: true }, () => {});
      }
    }
    this.consumidos = this.consumidos.filter(run => {
      if (this.linha.some(s => s.run === run)) return true;
      fs.rm(run.dir, { recursive: true, force: true }, () => {});
      return false;
    });
  }

  // ---------- playlists ----------

  janelaAtual() {
    const w = this.linha.slice(-this.janela);
    const antes = this.linha.slice(0, this.linha.length - w.length);
    return { w, descSeq: this.descBase + antes.filter(s => s.disc).length };
  }

  playlistMidia(uriDe) {
    const { w, descSeq } = this.janelaAtual();
    if (!w.length) return null;
    const linhas = ['#EXTM3U', '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...w.map(s => s.dur)))}`,
      `#EXT-X-MEDIA-SEQUENCE:${w[0].seq}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${descSeq}`];
    for (const s of w) {
      if (s.disc) linhas.push('#EXT-X-DISCONTINUITY');
      linhas.push(`#EXTINF:${s.dur.toFixed(3)},`, uriDe(s));
    }
    return linhas.join('\n') + '\n';
  }

  playlistQualidade(i) {
    if (i >= this.qs.length) return null;
    return this.playlistMidia(s => `r${s.run.n}/${s.uri.replace(/^q0_/, `q${i}_`)}`);
  }

  playlistLegenda(idioma) {
    if (!this.idiomas.includes(idioma)) return null;
    return this.playlistMidia(s => `sub_${idioma}/${s.seq}.vtt`);
  }

  master() {
    if (!this.linha.length) return null;
    const linhas = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
    const padrao = legendas.normalizarIdioma(this.c.idiomaLegenda || this.cfg.idiomaLegendaPadrao);
    for (const i of this.idiomas) {
      linhas.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${legendas.nomeIdioma(i)}",LANGUAGE="${legendas.codigoIdioma(i)}",` +
        `DEFAULT=${i === padrao ? 'YES' : 'NO'},AUTOSELECT=YES,FORCED=NO,URI="sub_${i}.m3u8"`);
    }
    this.qs.forEach((q, i) => {
      const banda = (this.c.copiar && this.qs.length === 1 ? 4000000 : cod.bps(q.bitrate)) + 128000;
      linhas.push(`#EXT-X-STREAM-INF:BANDWIDTH=${banda},NAME="${q.nome}"${this.idiomas.length ? ',SUBTITLES="subs"' : ''}`,
        `q${i}.m3u8`);
    });
    return linhas.join('\n') + '\n';
  }

  async pedacoLegenda(idioma, seq) {
    const s = this.linha.find(x => x.seq === seq);
    if (!s || !this.idiomas.includes(idioma)) return null;
    const fonte = s.run.item?.legendas[idioma];
    if (!fonte) return 'WEBVTT\n\n'; // este episódio não tem legenda nesse idioma
    const lista = await legendas.cues(s.run.item.video, fonte);
    return legendas.pedacoVtt(lista, s.local, s.local + s.dur, s.run.pts, s.run.offset);
  }

  arquivoSegmento(rel) { // "r3/q1_00004.ts"
    const m = rel.match(/^r(\d+)\/(q\d+_\d+\.ts)$/);
    if (!m) return null;
    return path.join(this.dir, `r${m[1]}`, m[2]);
  }

  parar() {
    this.parado = true;
    clearInterval(this.timer);
    for (const run of [...this.runs, ...this.consumidos]) {
      clearTimeout(run.timerProximo);
      run.proc?.kill('SIGTERM');
    }
    fs.rm(this.dir, { recursive: true, force: true }, () => {});
  }
}

// ---------- gerenciador: liga sob demanda, desliga sem espectadores ----------

const ativas = new Map();

function obter(c, cfg) {
  let t = ativas.get(c.id);
  if (t && !t.parado) {
    t.ultimoAcesso = Date.now();
    return t;
  }
  t = new Transmissao(c, cfg);
  ativas.set(c.id, t);
  console.log(`[${c.id}] canal ligado`);
  t.aoErro = erro => { console.error(`[${c.id}] ${erro}`); parar(c.id); };
  t.iniciar().catch(e => t.aoErro(e.message));
  return t;
}

function parar(id) {
  const t = ativas.get(id);
  if (!t) return;
  t.parar();
  ativas.delete(id);
}

async function aguardarPronta(t, ms = 25_000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (t.linha.length) return true;
    if (t.parado) return false;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

function vigiarOciosos(segundos) {
  return setInterval(() => {
    for (const [id, t] of ativas) {
      if (Date.now() - t.ultimoAcesso > segundos * 1000) {
        console.log(`[${id}] sem espectadores, desligando`);
        parar(id);
      }
    }
  }, 5_000);
}

module.exports = { Transmissao, obter, parar, aguardarPronta, vigiarOciosos, ativas, lerPlaylist };
