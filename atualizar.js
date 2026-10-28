// Atualiza a lista de canais públicos agora: node atualizar.js
// (o servidor já faz isso sozinho no intervalo de fontes.json)
require('./lib/config').prepararRaiz();
require('./lib/atualizar').atualizar()
  .then(() => process.exit(0))
  .catch(e => { console.error(`[atualizar] erro: ${e.message}`); process.exit(1); });
