// Lista única de canais: os seus (channels.json) + os públicos (dados/externos.json),
// com favoritos, ocultos e numeração de preferencias.json aplicados.
const crypto = require('crypto');
const config = require('./config');

const TIPOS = new Set(['teste', 'arquivo', 'pasta', 'url']);
let estado = { todos: [], porId: new Map(), porNum: new Map(), atualizadoEm: null, meus: [], externos: [] };

function validarMeus(lista) {
  if (!Array.isArray(lista)) throw new Error('channels.json deve ser uma lista [ ... ]');
  const ids = new Set();
  for (const c of lista) {
    if (!c || !/^[a-z0-9_-]+$/.test(c.id || '')) throw new Error(`id inválido: "${c?.id}" (use a-z, 0-9, - e _)`);
    if (c.id.startsWith('x-')) throw new Error(`"${c.id}": ids começando com x- são dos canais públicos`);
    if (ids.has(c.id)) throw new Error(`id repetido: ${c.id}`);
    ids.add(c.id);
    if (!TIPOS.has(c.tipo)) throw new Error(`${c.id}: tipo "${c.tipo}" inválido (use ${[...TIPOS].join(', ')})`);
    if (c.tipo !== 'teste' && !c.origem) throw new Error(`${c.id}: falta "origem"`);
    if (!c.nome) throw new Error(`${c.id}: falta "nome"`);
  }
}

// número estável para apps no padrão Xtream (que só aceitam ids numéricos)
const numId = id => parseInt(crypto.createHash('sha1').update(id).digest('hex').slice(0, 7), 16);

function recarregar() {
  const meus = config.meusCanais();
  validarMeus(meus);
  const ext = config.lerJson(config.P.externos, { canais: [] });
  // formato antigo (um link só por canal)
  const externos = (ext.canais || []).map(c => (c.origens ? c : {
    ...c, origens: [{ url: c.origem, userAgent: c.userAgent, referrer: c.referrer }],
  }));
  const prefs = config.preferencias();
  const favoritos = prefs.favoritos || [];
  const ocultos = new Set(prefs.ocultos || []);

  const todos = [...meus.map(c => ({ ...c, local: true })), ...externos.map(c => ({ ...c, local: false }))]
    .map(c => ({ ...c, favorito: favoritos.includes(c.id), oculto: ocultos.has(c.id), numId: numId(c.id) }));
  const pos = id => favoritos.indexOf(id);
  todos.sort((a, b) => (b.favorito - a.favorito) || (a.favorito && pos(a.id) - pos(b.id)) || (b.local - a.local));

  // números fixos de preferencias.json; os demais em sequência, pulando os já usados
  const fixos = prefs.numeros || {};
  const usados = new Set(Object.values(fixos).map(Number));
  let proximo = 1;
  for (const c of todos) {
    if (c.oculto) continue;
    if (fixos[c.id]) { c.numero = Number(fixos[c.id]); continue; }
    while (usados.has(proximo)) proximo++;
    c.numero = proximo++;
  }

  estado = {
    todos,
    porId: new Map(todos.map(c => [c.id, c])),
    porNum: new Map(todos.map(c => [c.numId, c])),
    atualizadoEm: ext.atualizadoEm || null,
    meus,
    externos: todos.filter(c => !c.local),
  };
  return estado;
}

const visiveis = () => estado.todos.filter(c => !c.oculto).sort((a, b) => a.numero - b.numero);
const grupoDe = c => (c.favorito ? '★ Favoritos' : c.grupo || (c.local ? 'Meus canais' : 'Outros'));

module.exports = {
  recarregar, validarMeus, visiveis, grupoDe, numId,
  todos: () => estado.todos,
  porId: id => estado.porId.get(id),
  porNum: n => estado.porNum.get(Number(n)),
  externos: () => estado.externos,
  atualizadoEm: () => estado.atualizadoEm,
};
