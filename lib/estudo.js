// Modo estudo: análise das falas em japonês (palavra por palavra, leitura, forma de
// dicionário, significado) e cartões salvos por usuário, exportáveis para o Anki.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('./config');

const SCRIPT = path.join(config.P.codigo, 'scripts', 'estudo.py');
const DICIONARIO = path.join(config.P.dados, 'jmdict-eng-common.json');
const CARTOES = path.join(config.P.dados, 'estudo');

let worker = null;
let erro = null;
let proximoId = 1;
const pendentes = new Map();
const cache = new Map();

function cfg() {
  const c = config.config();
  return { ...c.estudo, python: c.estudo.python || c.transcricao.python };
}

function iniciarWorker() {
  if (worker) return worker;
  const args = [SCRIPT];
  if (fs.existsSync(DICIONARIO)) args.push(DICIONARIO);
  const p = spawn(cfg().python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  worker = p;
  erro = null;
  let buffer = '';
  let stderr = '';
  p.stdout.on('data', d => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const linha = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      let msg;
      try { msg = JSON.parse(linha); } catch { continue; }
      const pend = pendentes.get(msg.id);
      if (pend) { pendentes.delete(msg.id); clearTimeout(pend.timer); pend.ok(msg.tokens); }
    }
  });
  p.stderr.on('data', d => {
    stderr = (stderr + d).slice(-4000);
    if (/dicionário/.test(String(d))) console.log(`[estudo] ${String(d).trim()}`);
  });
  p.on('error', e => {
    erro = e.code === 'ENOENT' ? `${cfg().python} não encontrado` : e.message;
  });
  p.on('exit', code => {
    if (worker === p) worker = null;
    if (code) erro = /fugashi|unidic/i.test(stderr) ? 'instale: pip install fugashi unidic-lite'
      : (stderr.trim().split('\n').pop() || `análise encerrou (código ${code})`);
    for (const [id, pend] of pendentes) { clearTimeout(pend.timer); pend.falha(new Error(erro || 'análise encerrou')); pendentes.delete(id); }
  });
  return p;
}

function analisar(texto) {
  texto = String(texto || '').slice(0, 500).trim();
  if (!texto) return Promise.resolve([]);
  if (cache.has(texto)) return Promise.resolve(cache.get(texto));
  const p = iniciarWorker();
  return new Promise((ok, falha) => {
    const id = proximoId++;
    const timer = setTimeout(() => { pendentes.delete(id); falha(new Error(erro || 'análise demorou demais')); }, 15_000);
    pendentes.set(id, {
      timer, falha,
      ok: tokens => {
        if (cache.size > 3000) cache.delete(cache.keys().next().value);
        cache.set(texto, tokens);
        ok(tokens);
      },
    });
    p.stdin.write(JSON.stringify({ id, texto }) + '\n', e => { if (e) falha(new Error(erro || e.message)); });
  });
}

// ---------- dicionário (JMdict, palavras comuns, significados em inglês) ----------

// .zip com um arquivo só: lê o cabeçalho local e descompacta (sem dependências)
function extrairZipUnico(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('não é um .zip');
  const metodo = buf.readUInt16LE(8);
  let tamanho = buf.readUInt32LE(18);
  const nome = buf.readUInt16LE(26);
  const extra = buf.readUInt16LE(28);
  const inicio = 30 + nome + extra;
  if (buf.readUInt16LE(6) & 0x08) {
    // tamanho só no diretório central (fim do arquivo)
    const fimCentral = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const central = buf.readUInt32LE(fimCentral + 16);
    tamanho = buf.readUInt32LE(central + 20);
  }
  const dados = buf.subarray(inicio, inicio + tamanho);
  if (metodo === 0) return dados;
  if (metodo === 8) return zlib.inflateRawSync(dados);
  throw new Error(`compressão ${metodo} não suportada`);
}

let baixando = false;
async function baixarDicionario() {
  if (!cfg().dicionario || baixando || fs.existsSync(DICIONARIO)) return;
  baixando = true;
  try {
    const r = await fetch('https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest',
      { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`GitHub respondeu HTTP ${r.status}`);
    const asset = (await r.json()).assets?.find(a => /^jmdict-eng-common-.*\.json\.zip$/.test(a.name));
    if (!asset) throw new Error('arquivo do dicionário não encontrado na última versão');
    const zip = Buffer.from(await (await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(300_000) })).arrayBuffer());
    const json = extrairZipUnico(zip);
    if (!json.toString('utf8', 0, 50).trimStart().startsWith('{')) throw new Error('o arquivo baixado não é JSON');
    fs.mkdirSync(path.dirname(DICIONARIO), { recursive: true });
    fs.writeFileSync(`${DICIONARIO}.tmp`, json);
    fs.renameSync(`${DICIONARIO}.tmp`, DICIONARIO);
    console.log(`[estudo] dicionário baixado: ${asset.name}`);
    cache.clear();
    if (worker) worker.stdin.write(JSON.stringify({ recarregar: DICIONARIO }) + '\n');
  } catch (e) {
    console.warn(`[estudo] não consegui baixar o dicionário: ${e.message} (o modo estudo funciona sem significados)`);
  } finally {
    baixando = false;
  }
}

// ---------- cartões ----------

const arquivoDe = usuario => path.join(CARTOES, `${String(usuario).replace(/[^\w.-]/g, '_')}.json`);
const listar = usuario => config.lerJson(arquivoDe(usuario), []);
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

const rubyHtml = tokens => tokens.map(t => t.ruby.map(([txt, rt]) => (rt ? `<ruby>${esc(txt)}<rt>${esc(rt)}</rt></ruby>` : esc(txt))).join('')).join('');

async function adicionar(usuario, dados) {
  const frase = String(dados.frase || '').slice(0, 500).trim();
  if (!frase) throw new Error('falta a frase');
  let tokens = [];
  try { tokens = await analisar(frase); } catch {}
  const p = dados.palavra && tokens.find(t => t.s === dados.palavra);
  const cartao = {
    id: crypto.randomBytes(6).toString('hex'),
    criadoEm: new Date().toISOString(),
    frase,
    fraseRuby: tokens.length ? rubyHtml(tokens) : esc(frase),
    traducao: String(dados.traducao || '').slice(0, 500),
    fonte: String(dados.fonte || '').slice(0, 200),
    tempo: Number(dados.tempo) || 0,
    ...(p ? { palavra: p.s, base: p.base, leitura: p.leitura, baseLeitura: p.baseLeitura, classe: p.classe, glosas: p.glosas } : {}),
  };
  const lista = listar(usuario);
  if (lista.some(c => c.frase === cartao.frase && c.palavra === cartao.palavra)) return lista.find(c => c.frase === cartao.frase && c.palavra === cartao.palavra);
  lista.push(cartao);
  config.gravarJson(arquivoDe(usuario), lista);
  return cartao;
}

function remover(usuario, id) {
  const lista = listar(usuario);
  const nova = lista.filter(c => c.id !== id);
  config.gravarJson(arquivoDe(usuario), nova);
  return lista.length !== nova.length;
}

// Texto separado por tabulação, no formato que o Anki importa (Arquivo → Importar)
function anki(usuario) {
  const campo = s => String(s ?? '').replace(/[\t\r\n]+/g, ' ');
  const linhas = ['#separator:tab', '#html:true', '#tags column:3'];
  for (const c of listar(usuario)) {
    const frente = c.palavra ? `<b>${esc(c.palavra)}</b><br><br>${c.fraseRuby}` : c.fraseRuby;
    const verso = [
      c.palavra ? `<b>${esc(c.base)}</b> (${esc(c.baseLeitura || c.leitura)}) · ${esc(c.classe)}` : '',
      c.glosas?.length ? esc(c.glosas.join(' / ')) : '',
      c.traducao ? `<i>${esc(c.traducao)}</i>` : '',
      c.fonte ? `<small>${esc(c.fonte)}${c.tempo ? ` · ${new Date(c.tempo * 1000).toISOString().slice(11, 19)}` : ''}</small>` : '',
    ].filter(Boolean).join('<br>');
    linhas.push([campo(frente), campo(verso), 'iptv japones'].join('\t'));
  }
  return linhas.join('\n') + '\n';
}

function estado() {
  return { disponivel: !erro, erro, dicionario: fs.existsSync(DICIONARIO) };
}

module.exports = { analisar, baixarDicionario, listar, adicionar, remover, anki, estado, extrairZipUnico, rubyHtml, DICIONARIO };
