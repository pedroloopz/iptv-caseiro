#!/usr/bin/env python3
"""Analisa frases em japonês para o modo estudo (fica rodando, uma frase por linha).

Entrada (stdin), uma linha JSON por pedido:  {"id": 1, "texto": "今日は天気がいい"}
Saída (stdout), uma linha JSON por resposta: {"id": 1, "tokens": [{"s": "今日", "leitura": "きょう",
    "base": "今日", "baseLeitura": "きょう", "classe": "substantivo", "ruby": [["今日", "きょう"]], "glosas": ["today"]}, ...]}

uso: estudo.py [CAMINHO_DO_JMDICT.json]
Precisa de: pip install fugashi unidic-lite
O dicionário (glosas em inglês) é o JMdict, em JSON (github.com/scriptin/jmdict-simplified);
o servidor baixa sozinho na primeira vez.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from furigana import KANJI, KANJI_RUN, LEITURAS, hiragana  # noqa: E402

CLASSES = {
    "名詞": "substantivo", "代名詞": "pronome", "動詞": "verbo", "形容詞": "adjetivo (い)",
    "形状詞": "adjetivo (な)", "副詞": "advérbio", "助詞": "partícula", "助動詞": "auxiliar",
    "接続詞": "conjunção", "感動詞": "interjeição", "連体詞": "pré-nominal", "接頭辞": "prefixo",
    "接尾辞": "sufixo", "数詞": "número", "記号": "símbolo", "補助記号": "pontuação", "空白": "espaço",
}

DIC = {}


def carregar_dicionario(caminho):
    """JMdict simplificado: forma escrita (kanji ou kana) -> primeiras glosas."""
    try:
        with open(caminho, encoding="utf-8") as f:
            dados = json.load(f)
        novo = {}
        for w in dados.get("words", []):
            glosas = []
            for sentido in w.get("sense", []):
                textos = [g["text"] for g in sentido.get("gloss", []) if g.get("lang", "eng") == "eng"]
                if textos:
                    glosas.append("; ".join(textos[:3]))
                if len(glosas) >= 3:
                    break
            if not glosas:
                continue
            for forma in w.get("kanji", []) + w.get("kana", []):
                novo.setdefault(forma["text"], glosas)
        DIC.update(novo)
        print(f"dicionário carregado: {len(novo)} formas", file=sys.stderr, flush=True)
    except Exception as e:  # sem dicionário a análise continua, só sem glosas
        print(f"dicionário indisponível: {e}", file=sys.stderr, flush=True)


def ruby(surface, leitura):
    """[["食", "た"], ["べ", None], ["物", "もの"]] — leitura só sobre os kanji."""
    if not KANJI.search(surface) or not leitura:
        return [[surface, None]]
    partes = re.findall(f"{KANJI_RUN}|[^㐀-鿿豈-﫿々〆ヶ]+", surface)
    padrao = "".join("(.+?)" if KANJI.match(p) else re.escape(hiragana(p)) for p in partes)
    m = re.fullmatch(padrao, leitura)
    if not m:
        return [[surface, leitura]]
    g = iter(m.groups())
    return [[p, next(g)] if KANJI.match(p) else [p, None] for p in partes]


def main():
    import fugashi
    tagger = fugashi.Tagger()
    # carrega antes de responder: nenhuma análise sai sem os significados (e vai para o cache assim)
    if len(sys.argv) > 1 and os.path.exists(sys.argv[1]):
        carregar_dicionario(sys.argv[1])

    print(json.dumps({"pronto": True}), flush=True)
    for linha in sys.stdin:
        try:
            pedido = json.loads(linha)
        except ValueError:
            continue
        if pedido.get("recarregar"):
            carregar_dicionario(pedido["recarregar"])
            continue
        tokens = []
        for w in tagger(pedido.get("texto", "")):
            f = w.feature
            kana = getattr(f, "kana", None)
            leitura = LEITURAS.get(w.surface) or (hiragana(kana) if kana and kana != "*" else "")
            base = (getattr(f, "orthBase", None) or getattr(f, "lemma", None) or w.surface).split("-")[0]
            base_kana = getattr(f, "kanaBase", None) or ""
            tokens.append({
                "s": w.surface,
                "leitura": leitura,
                "base": base,
                "baseLeitura": LEITURAS.get(base) or (hiragana(base_kana) if base_kana and base_kana != "*" else ""),
                "classe": CLASSES.get(getattr(f, "pos1", ""), ""),
                "ruby": ruby(w.surface, leitura),
                "glosas": DIC.get(base) or DIC.get(w.surface) or [],
                "espaco": bool(w.white_space),
            })
        print(json.dumps({"id": pedido.get("id"), "tokens": tokens}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
