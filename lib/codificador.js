// Argumentos do ffmpeg: qualidades (várias = o player escolhe conforme a internet)
// e codificação por hardware (placa de vídeo) quando configurada.
const QUALIDADES = {
  '1080p': { altura: 1080, bitrate: '5000k' },
  '720p': { altura: 720, bitrate: '2500k' },
  '480p': { altura: 480, bitrate: '1000k' },
  '360p': { altura: 360, bitrate: '600k' },
};

const ENCODERS = {
  cpu: { args: ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-sc_threshold', '0'], formato: 'format=yuv420p' },
  nvenc: { args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll'], formato: 'format=yuv420p' },
  qsv: { args: ['-c:v', 'h264_qsv', '-preset', 'veryfast'], formato: 'format=nv12' },
  vaapi: { args: ['-c:v', 'h264_vaapi'], formato: 'format=nv12,hwupload' },
  videotoolbox: { args: ['-c:v', 'h264_videotoolbox', '-realtime', '1'], formato: 'format=yuv420p' },
};

function qualidades(c, cfg) {
  const nomes = c.qualidades || cfg.qualidades;
  return nomes.map(nome => {
    const q = QUALIDADES[nome];
    if (!q) throw new Error(`qualidade desconhecida "${nome}" (use ${Object.keys(QUALIDADES).join(', ')})`);
    // "bitrate" do canal só vale quando há uma qualidade
    return { nome, ...q, bitrate: c.bitrate && nomes.length === 1 ? c.bitrate : q.bitrate };
  });
}

const bps = br => Number(String(br).replace(/k$/i, '')) * (/k$/i.test(br) ? 1000 : 1);

function encoder(cfg) {
  const e = ENCODERS[cfg.aceleracao];
  if (!e) throw new Error(`aceleracao desconhecida "${cfg.aceleracao}" (use ${Object.keys(ENCODERS).join(', ')})`);
  return e;
}

// Vão antes das entradas (-i)
const argsGlobais = cfg => (cfg.aceleracao === 'vaapi' ? ['-vaapi_device', cfg.dispositivoVaapi] : []);

// Uma saída HLS por qualidade: q0.m3u8 + q0_00000.ts, q1.m3u8…
// entradaVideo: rótulo do vídeo de entrada ("0:v:0"); filtroBase: filtros antes da escala (legenda gravada)
function argsSaidas({ cfg, c, dir, qs, entradaVideo = '0:v:0', entradaAudio = '0:a:0?', filtroBase = '' }) {
  const S = cfg.segundosSegmento;
  const hls = i => ['-f', 'hls', '-hls_time', String(S), '-hls_list_size', '20', '-hls_flags', 'independent_segments',
    '-hls_segment_filename', `${dir}/q${i}_%05d.ts`, `${dir}/q${i}.m3u8`];
  const audio = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'];

  // fonte já em H.264/AAC, uma qualidade e nada para desenhar: só reempacota (quase zero CPU)
  if (c.copiar && !filtroBase && qs.length === 1) {
    return ['-map', entradaVideo, '-map', entradaAudio, '-c', 'copy', ...hls(0)];
  }

  const e = encoder(cfg);
  const base = filtroBase ? `${filtroBase},` : '';
  const escala = q => `scale=-2:min(${q.altura}\\,ih),${e.formato}`;
  const grafo = qs.length === 1
    ? `[${entradaVideo.replace(/\?$/, '')}]${base}${escala(qs[0])}[v0]`
    : `[${entradaVideo.replace(/\?$/, '')}]${base}split=${qs.length}${qs.map((_, i) => `[s${i}]`).join('')};` +
      qs.map((q, i) => `[s${i}]${escala(q)}[v${i}]`).join(';');

  const args = ['-filter_complex', grafo];
  qs.forEach((q, i) => {
    args.push('-map', `[v${i}]`, '-map', entradaAudio, ...e.args,
      '-b:v', q.bitrate, '-maxrate', q.bitrate, '-bufsize', `${bps(q.bitrate) * 2 / 1000}k`,
      // keyframe a cada segmento, no mesmo instante em todas as qualidades
      '-force_key_frames', `expr:gte(t,n_forced*${S})`, ...audio, ...hls(i));
  });
  return args;
}

module.exports = { QUALIDADES, ENCODERS, qualidades, argsGlobais, argsSaidas, bps };
