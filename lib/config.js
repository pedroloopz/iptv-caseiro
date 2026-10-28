// Caminhos e arquivos de configuração. Tudo que é seu (canais, usuários, mídia,
// dados gerados) fica em IPTV_RAIZ — por padrão, a própria pasta do projeto.
const fs = require('fs');
const path = require('path');

const CODIGO = path.join(__dirname, '..');
const RAIZ = path.resolve(process.env.IPTV_RAIZ || CODIGO);

const P = {
  codigo: CODIGO,
  raiz: RAIZ,
  publico: path.join(CODIGO, 'public'),
  canais: path.join(RAIZ, 'channels.json'),
  fontes: path.join(RAIZ, 'fontes.json'),
  config: path.join(RAIZ, 'config.json'),
  preferencias: path.join(RAIZ, 'preferencias.json'),
  usuarios: path.join(RAIZ, 'usuarios.json'),
  dados: path.join(RAIZ, 'dados'),
  hls: path.join(RAIZ, 'hls'),
  externos: path.join(RAIZ, 'dados', 'externos.json'),
  epgExterno: path.join(RAIZ, 'dados', 'epg-externo.xml'),
};

const PADRAO = {
  config: {
    aceleracao: 'cpu',          // cpu | nvenc | qsv | vaapi | videotoolbox
    dispositivoVaapi: '/dev/dri/renderD128',
    qualidades: ['720p'],       // 1080p | 720p | 480p | 360p (várias = troca automática de qualidade)
    segundosSegmento: 4,
    janelaSegmentos: 6,
    ociosoSegundos: 60,
    verificarACadaMinutos: 15,  // reteste dos canais públicos entre as atualizações
    linksDiretos: false,        // true: playlist aponta direto para a fonte (sem troca automática de link)
    canaisPeloServidor: 'geo',
    esconderForaDoAr: true,     // canais públicos que falharam no teste somem dos apps (o painel mostra todos)  // nenhum | geo (só os bloqueados por país) | todos: a imagem passa pelo servidor
    biblioteca: 'biblioteca',   // pasta com filmes/ e series/
    tmdbApiKey: '',             // opcional: capas e sinopses (themoviedb.org)
    idiomaLegendaPadrao: 'pt',
    https: { cert: '', key: '' },
    epgIptvOrg: { ativo: false, dias: 2, conexoes: 5 },
    // legenda automática em japonês (precisa de faster-whisper ou whisper.cpp; veja o README)
    // modo estudo (player web): análise das falas em japonês; precisa de fugashi + unidic-lite
    estudo: { dicionario: true, python: '' },
    transcricao: { ativo: false, motor: 'faster-whisper', modelo: 'small', dispositivo: 'auto',
      python: 'python3', whisperCpp: 'whisper-cli', furigana: true, detectarIdioma: true },
  },
  fontes: {
    atualizarACadaHoras: 6,
    listas: [],
    excluirGrupos: ['Religious', 'Shop', 'Legislative'],
    grupoPorPais: true,         // grupos dos canais públicos = país (Brasil, Japão…), não a categoria
    excluirNaoVinteQuatroHoras: false,
    excluirIpSolto: false,
    excluirHosts: [],
    testarStreams: true,
    testeCompleto: true,        // testa até o vídeo (pega bloqueio por país e DRM), não só a playlist
    timeoutTesteMs: 8000,
    simultaneos: 20,
    epgExterno: [],
  },
  preferencias: { favoritos: [], ocultos: [], numeros: {} },
};

const clonar = o => JSON.parse(JSON.stringify(o));

function lerJson(arquivo, padrao) {
  let texto;
  try {
    texto = fs.readFileSync(arquivo, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return clonar(padrao);
    throw e;
  }
  try {
    return JSON.parse(texto);
  } catch (e) {
    throw new Error(`${path.basename(arquivo)} está com erro de sintaxe: ${e.message}`);
  }
}

// grava em .tmp e renomeia: quem lê nunca pega o arquivo pela metade
function gravarJson(arquivo, dados) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(`${arquivo}.tmp`, JSON.stringify(dados, null, 2) + '\n');
  fs.renameSync(`${arquivo}.tmp`, arquivo);
}

const config = () => {
  const c = { ...PADRAO.config, ...lerJson(P.config, {}) };
  c.https = { ...PADRAO.config.https, ...c.https };
  c.epgIptvOrg = { ...PADRAO.config.epgIptvOrg, ...c.epgIptvOrg };
  c.transcricao = { ...PADRAO.config.transcricao, ...c.transcricao };
  c.estudo = { ...PADRAO.config.estudo, ...c.estudo };
  if (process.env.IPTV_CERT) c.https = { cert: process.env.IPTV_CERT, key: process.env.IPTV_KEY };
  return c;
};
const fontes = () => ({ ...PADRAO.fontes, ...lerJson(P.fontes, {}) });
const preferencias = () => ({ ...PADRAO.preferencias, ...lerJson(P.preferencias, {}) });
const meusCanais = () => lerJson(P.canais, []);
const usuarios = () => lerJson(P.usuarios, []);
const pastaBiblioteca = () => path.resolve(RAIZ, config().biblioteca);

// Na primeira execução com IPTV_RAIZ separada (ex.: Docker), copia os exemplos
function prepararRaiz() {
  fs.mkdirSync(P.dados, { recursive: true });
  if (RAIZ === CODIGO) return;
  for (const nome of ['channels.json', 'fontes.json', 'config.json']) {
    const destino = path.join(RAIZ, nome);
    if (!fs.existsSync(destino) && fs.existsSync(path.join(CODIGO, nome))) {
      fs.copyFileSync(path.join(CODIGO, nome), destino);
    }
  }
}

// Chama fn quando algum dos arquivos de configuração muda (edição à mão ou pelo painel)
function observar(fn) {
  const nomes = new Set([P.canais, P.fontes, P.config, P.preferencias, P.usuarios].map(a => path.basename(a)));
  let timer;
  try {
    fs.watch(RAIZ, (_, nome) => {
      if (!nome || !nomes.has(String(nome))) return;
      clearTimeout(timer);
      timer = setTimeout(() => fn(String(nome)), 300);
    });
  } catch (e) {
    console.warn(`[config] não consegui observar ${RAIZ}: ${e.message} (reinicie após editar)`);
  }
}

module.exports = { P, PADRAO, lerJson, gravarJson, config, fontes, preferencias, meusCanais, usuarios,
  pastaBiblioteca, prepararRaiz, observar };
