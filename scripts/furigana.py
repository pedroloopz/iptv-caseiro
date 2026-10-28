#!/usr/bin/env python3
"""Cria uma versão da legenda japonesa com a leitura em hiragana depois dos kanji:
今日は天気がいい → 今日（きょう）は天気（てんき）がいい

uso: furigana.py ENTRADA.srt SAIDA.srt
Instalação: pip install fugashi unidic-lite   (análise morfológica do MeCab; a leitura
depende do contexto, ex.: 今日は = きょうは, não こんにちは)
"""
import re
import sys

KANJI = re.compile(r"[㐀-鿿豈-﫿々〆ヶ]")
# o dicionário prefere leituras formais; estas são as do dia a dia
LEITURAS = {"日本": "にほん", "明日": "あした", "私": "わたし", "昨日": "きのう", "一昨日": "おととい",
            "今朝": "けさ", "何": "なに", "一日": "いちにち", "大人": "おとな"}


def hiragana(texto):
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in texto)


KANJI_RUN = r"[\u3400-\u9fff\uf900-\ufaff々〆ヶ]+"


def com_leitura(surface, leitura):
    """Põe a leitura só nos kanji, alinhando pelo kana que já está escrito:
    行き/いき -> 行（い）き ; 食べ物/たべもの -> 食（た）べ物（もの）"""
    if not KANJI.search(surface) or not leitura or leitura == surface:
        return surface
    partes = re.findall(f"{KANJI_RUN}|[^\u3400-\u9fff\uf900-\ufaff々〆ヶ]+", surface)
    padrao = "".join("(.+?)" if KANJI.match(p) else re.escape(hiragana(p)) for p in partes)
    m = re.fullmatch(padrao, leitura)
    if not m:
        return f"{surface}（{leitura}）"
    grupos = iter(m.groups())
    return "".join(f"{p}（{next(grupos)}）" if KANJI.match(p) else p for p in partes)


def juntar_kanji(tokens):
    """日本+語 viram 日本語（にほんご）: palavras só de kanji em sequência ficam juntas."""
    saida = []
    for surface, leitura in tokens:
        so_kanji = bool(re.fullmatch(KANJI_RUN, surface))
        if so_kanji and saida and saida[-1][2] and leitura and saida[-1][1]:
            s0, l0, _ = saida[-1]
            saida[-1] = (s0 + surface, l0 + leitura, True)
        else:
            saida.append((surface, leitura, so_kanji))
    return "".join(com_leitura(s, l) for s, l, _ in saida)


def criar_conversor():
    try:
        import fugashi
        tagger = fugashi.Tagger()

        def converter(linha):
            tokens = []
            for w in tagger(linha):
                f = w.feature
                kana = getattr(f, "kana", None) or getattr(f, "pron", None)
                tokens.append((w.surface, LEITURAS.get(w.surface) or (hiragana(kana) if kana and kana != "*" else None)))
            return juntar_kanji(tokens)
        return converter
    except ImportError:
        pass
    try:  # alternativa mais simples (erra mais leituras que dependem do contexto)
        import pykakasi
        k = pykakasi.kakasi()
        return lambda linha: juntar_kanji((t["orig"], LEITURAS.get(t["orig"], t["hira"])) for t in k.convert(linha))
    except ImportError:
        print("instale: pip install fugashi unidic-lite", file=sys.stderr)
        sys.exit(2)


def main():
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    entrada, saida = sys.argv[1], sys.argv[2]
    converter = criar_conversor()
    with open(entrada, encoding="utf-8-sig") as f:
        linhas = f.read().splitlines()
    out = []
    for linha in linhas:
        # números de fala, tempos e linhas vazias ficam como estão
        if not linha.strip() or linha.strip().isdigit() or "-->" in linha or linha.startswith("WEBVTT"):
            out.append(linha)
        else:
            out.append(converter(linha))
    with open(saida + ".tmp", "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    import os
    os.replace(saida + ".tmp", saida)


if __name__ == "__main__":
    main()
