FROM node:22-bookworm-slim

# ffmpeg, fonte japonesa (legendas gravadas), fuso horário e git (coletor de guia, opcional)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk tzdata git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# legenda automática em japonês (opcional, +~800 MB, fora os modelos): docker compose build --build-arg TRANSCRICAO=1
ARG TRANSCRICAO=0
RUN if [ "$TRANSCRICAO" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
      && python3 -m venv /opt/venv \
      && /opt/venv/bin/pip install --no-cache-dir faster-whisper fugashi unidic-lite \
      && rm -rf /var/lib/apt/lists/*; \
    fi
# python3 do venv (quando instalado) vem antes do sistema; modelos do Whisper ficam no volume
ENV PATH="/opt/venv/bin:$PATH" HF_HOME=/dados/modelos

WORKDIR /app
COPY package.json server.js atualizar.js channels.json fontes.json config.json ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

# tudo que é seu (configuração, mídia, biblioteca, dados) fica no volume /dados
ENV IPTV_RAIZ=/dados PORT=8080 TZ=America/Sao_Paulo
VOLUME /dados
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
