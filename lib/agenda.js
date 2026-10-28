// Programação pelo relógio: os vídeos de um canal formam um ciclo que "passa"
// continuamente desde uma data fixa, como uma TV de verdade. Ao ligar o canal,
// ele entra no ponto exato do que estaria passando agora — e o guia (EPG) sai
// automaticamente das durações dos arquivos.
const fs = require('fs');
const path = require('path');
const { P } = require('./config');
const { sondar, listarVideos, tituloDoArquivo } = require('./midia');

const ANCORA = Date.UTC(2026, 0, 1); // o ciclo de todo canal "começou" aqui

function arquivosDoCanal(c) {
  const origem = path.resolve(P.raiz, c.origem);
  if (c.tipo === 'arquivo') return fs.existsSync(origem) ? [origem] : [];
  if (!fs.existsSync(origem)) return [];
  return listarVideos(origem, c.recursivo !== false);
}

// [{ video, titulo, duracao }]; vídeos ilegíveis ficam de fora (com aviso)
async function montar(c) {
  const itens = [];
  for (const video of arquivosDoCanal(c)) {
    try {
      const info = await sondar(video);
      if (info.duracao > 1) itens.push({ video, titulo: tituloDoArquivo(video), duracao: info.duracao, info });
    } catch (e) {
      console.warn(`[${c.id}] ignorando ${path.basename(video)}: ${e.message}`);
    }
  }
  return itens;
}

// Onde o ciclo está no instante agoraMs: índice do vídeo e segundos dentro dele
function posicao(itens, agoraMs = Date.now()) {
  const ciclo = itens.reduce((s, i) => s + i.duracao, 0);
  if (!ciclo) return null;
  let t = (((agoraMs - ANCORA) / 1000) % ciclo + ciclo) % ciclo;
  for (let i = 0; i < itens.length; i++) {
    if (t < itens[i].duracao) return { indice: i, offset: t };
    t -= itens[i].duracao;
  }
  return { indice: 0, offset: 0 };
}

// Grade entre deMs e ateMs: [{ inicio, fim, titulo }] (em ms)
function grade(itens, deMs, ateMs, limite = 500) {
  const pos = posicao(itens, deMs);
  if (!pos) return [];
  const saida = [];
  let i = pos.indice;
  let inicio = deMs - pos.offset * 1000;
  while (inicio < ateMs && saida.length < limite) {
    const fim = inicio + itens[i].duracao * 1000;
    saida.push({ inicio, fim, titulo: itens[i].titulo });
    inicio = fim;
    i = (i + 1) % itens.length;
  }
  return saida;
}

module.exports = { montar, posicao, grade, arquivosDoCanal, ANCORA };
