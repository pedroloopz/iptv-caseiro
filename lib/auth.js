// Usuários e senhas (usuarios.json), cada um com sua senha — dá para cancelar o
// acesso de uma pessoa ou de um aparelho sem trocar a dos outros.
// Sem usuários cadastrados (e sem IPTV_TOKEN), o servidor fica aberto: só para uso em casa.
const crypto = require('crypto');
const config = require('./config');

let lista = [];

function carregar() {
  const usuarios = config.usuarios().filter(u => u && u.usuario && u.senha && u.ativo !== false);
  if (process.env.IPTV_TOKEN && !usuarios.some(u => u.senha === process.env.IPTV_TOKEN)) {
    usuarios.push({ usuario: 'admin', senha: process.env.IPTV_TOKEN, admin: true });
  }
  lista = usuarios.map(u => ({ ...u, hash: crypto.createHash('sha256').update(String(u.senha)).digest() }));
  return lista;
}

const aberto = () => lista.length === 0;
const ANONIMO = { usuario: 'livre', admin: true, senha: '' };

// compara com todos, sempre, em tempo constante: não vaza qual parte acertou
function porSenha(senha, usuario) {
  if (aberto()) return ANONIMO;
  if (!senha) return null;
  const h = crypto.createHash('sha256').update(String(senha)).digest();
  let achado = null;
  for (const u of lista) {
    const ok = crypto.timingSafeEqual(h, u.hash) && (usuario === undefined || usuario === u.usuario);
    if (ok && !achado) achado = u;
  }
  return achado;
}

function validar(usuarios) {
  if (!Array.isArray(usuarios)) throw new Error('usuarios deve ser uma lista');
  const senhas = new Set();
  const nomes = new Set();
  for (const u of usuarios) {
    if (!u.usuario || !/^[\w.-]{1,40}$/.test(u.usuario)) throw new Error(`usuário inválido: "${u.usuario}" (letras, números, . _ -)`);
    if (!u.senha || String(u.senha).length < 8) throw new Error(`a senha de ${u.usuario} precisa de pelo menos 8 caracteres`);
    if (nomes.has(u.usuario)) throw new Error(`usuário repetido: ${u.usuario}`);
    if (senhas.has(u.senha)) throw new Error('cada usuário precisa de uma senha diferente (a senha também é o token dos links)');
    nomes.add(u.usuario);
    senhas.add(u.senha);
  }
  if (usuarios.length && !usuarios.some(u => u.admin && u.ativo !== false)) throw new Error('deixe pelo menos um administrador ativo');
}

const gerarSenha = () => crypto.randomBytes(12).toString('base64url');

// ---------- limite de tentativas ----------
const tentativas = new Map(); // ip -> { falhas, desde, bloqueadoAte }
const MAX_FALHAS = 10, JANELA_MS = 10 * 60_000, BLOQUEIO_MS = 15 * 60_000;

function bloqueado(ip) {
  const t = tentativas.get(ip);
  return Boolean(t && t.bloqueadoAte > Date.now());
}

function registrarFalha(ip) {
  const agora = Date.now();
  let t = tentativas.get(ip);
  if (!t || agora - t.desde > JANELA_MS) t = { falhas: 0, desde: agora, bloqueadoAte: 0 };
  t.falhas++;
  if (t.falhas >= MAX_FALHAS) {
    t.bloqueadoAte = agora + BLOQUEIO_MS;
    console.warn(`[auth] ${ip} bloqueado por 15 min após ${t.falhas} senhas erradas`);
  }
  tentativas.set(ip, t);
}

setInterval(() => {
  const agora = Date.now();
  for (const [ip, t] of tentativas) if (agora - t.desde > JANELA_MS && t.bloqueadoAte < agora) tentativas.delete(ip);
}, 60_000).unref();

module.exports = { carregar, porSenha, aberto, validar, gerarSenha, bloqueado, registrarFalha, MAX_FALHAS };
