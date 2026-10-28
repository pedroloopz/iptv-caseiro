#!/usr/bin/env python3
"""Transcreve um áudio com o faster-whisper e grava uma legenda .srt.

uso: transcrever.py AUDIO SAIDA.srt [--modelo small] [--idioma ja] [--detectar] [--dispositivo auto]

Imprime um JSON no stdout: {"idioma": "ja", "probabilidade": 0.98, "falas": 123}
Sai com código 3 quando --detectar está ligado e o áudio não está no idioma pedido.
Instalação: pip install faster-whisper
"""
import argparse
import json
import os
import sys


def tempo(segundos):
    ms = int(round(segundos * 1000))
    return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("saida")
    ap.add_argument("--modelo", default="small")
    ap.add_argument("--idioma", default="ja")
    ap.add_argument("--detectar", action="store_true", help="confere o idioma antes de transcrever")
    ap.add_argument("--dispositivo", default="auto", help="auto, cpu ou cuda")
    a = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper não está instalado: pip install faster-whisper", file=sys.stderr)
        sys.exit(2)

    modelo = WhisperModel(a.modelo, device=a.dispositivo, compute_type="auto")
    # vad_filter pula os silêncios (onde o Whisper costuma "inventar" falas);
    # sem condicionar no texto anterior, evita repetir a mesma frase em loop
    falas, info = modelo.transcribe(
        a.audio,
        language=None if a.detectar else a.idioma,
        vad_filter=True,
        beam_size=5,
        condition_on_previous_text=False,
    )
    if a.detectar and info.language != a.idioma:
        print(json.dumps({"idioma": info.language, "probabilidade": round(info.language_probability, 3)}))
        sys.exit(3)

    n = 0
    tmp = a.saida + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for s in falas:
            texto = s.text.strip()
            if not texto:
                continue
            n += 1
            f.write(f"{n}\n{tempo(s.start)} --> {tempo(s.end)}\n{texto}\n\n")
    os.replace(tmp, a.saida)
    print(json.dumps({"idioma": info.language, "probabilidade": round(info.language_probability, 3), "falas": n}))


if __name__ == "__main__":
    main()
