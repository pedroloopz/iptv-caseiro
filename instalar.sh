#!/usr/bin/env bash
# Instala (ou atualiza) o IPTV caseiro num servidor Ubuntu — Oracle Cloud, outra VPS
# ou um mini PC. Rode de novo a qualquer momento para atualizar: seus dados ficam.
#
#   curl -fsSL https://raw.githubusercontent.com/pedroloopz/iptv-caseiro/main/instalar.sh | bash
#
# Opções (antes do bash):  IPTV_PORTA=8080  IPTV_ESTUDO=1 (MeCab: modo estudo/furigana)
#                          IPTV_TRANSCRICAO=1 (Whisper: legenda automática, pesado)
set -euo pipefail

REPO="${IPTV_REPO:-https://github.com/pedroloopz/iptv-caseiro.git}"
RAMO="${IPTV_RAMO:-main}"
CODIGO="${IPTV_CODIGO:-$HOME/iptv-codigo}"     # código (substituído a cada atualização)
DADOS="${IPTV_DADOS:-$HOME/iptv-dados}"        # seus canais, usuários, vídeos e configurações
PORTA="${IPTV_PORTA:-8080}"
ESTUDO="${IPTV_ESTUDO:-1}"
TRANSCRICAO="${IPTV_TRANSCRICAO:-0}"

passo() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
USUARIO="$(id -un)"

if [ -z "${IPTV_SEM_APT:-}" ]; then
  passo "Instalando programas (ffmpeg, git, fonte japonesa, Python)"
  echo iptables-persistent iptables-persistent/autosave_v4 boolean true | $SUDO debconf-set-selections
  echo iptables-persistent iptables-persistent/autosave_v6 boolean true | $SUDO debconf-set-selections
  $SUDO apt-get update -y
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg git curl ca-certificates openssl \
    fonts-noto-cjk python3-venv iptables-persistent

  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    passo "Instalando Node.js 22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
  fi
fi

# máquinas com pouca memória (ex.: Oracle E2.1.Micro, 1 GB): 2 GB de swap evitam travar por falta de RAM
MEM_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "${MEM_KB:-0}" -lt 2000000 ] && [ -z "${IPTV_SEM_SWAP:-}" ] && ! swapon --show 2>/dev/null | grep -q .; then
  passo "Pouca memória: criando 2 GB de swap"
  $SUDO fallocate -l 2G /swapfile 2>/dev/null || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
fi

passo "Baixando o IPTV ($RAMO)"
if [ -d "$CODIGO/.git" ]; then
  git -C "$CODIGO" fetch -q --depth 1 origin "$RAMO"
  git -C "$CODIGO" checkout -q -f -B "$RAMO" FETCH_HEAD
else
  git clone -q --depth 1 --branch "$RAMO" "$REPO" "$CODIGO"
fi
APP="$CODIGO"
mkdir -p "$DADOS"
[ -f "$DADOS/config.json" ] || cp "$APP/config.json" "$DADOS/config.json"

PYTHON=python3
if [ "$ESTUDO" = 1 ] || [ "$TRANSCRICAO" = 1 ]; then
  passo "Instalando o Python do modo estudo$( [ "$TRANSCRICAO" = 1 ] && echo ' e da legenda automática (demora)')"
  [ -x "$DADOS/venv/bin/python" ] || python3 -m venv "$DADOS/venv"
  PACOTES="fugashi unidic-lite"
  [ "$TRANSCRICAO" = 1 ] && PACOTES="$PACOTES faster-whisper"
  # shellcheck disable=SC2086
  "$DADOS/venv/bin/pip" install -q --upgrade $PACOTES
  PYTHON="$DADOS/venv/bin/python"
fi

# aponta o config.json para o Python instalado (sem mexer no resto das suas configurações)
node -e '
  const fs = require("fs"); const [arq, py, transc] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(arq, "utf8"));
  c.transcricao = { ...c.transcricao, python: py };
  if (transc === "1") c.transcricao.ativo = true;
  fs.writeFileSync(arq, JSON.stringify(c, null, 2) + "\n");
' "$DADOS/config.json" "$PYTHON" "$TRANSCRICAO"

SENHA=""
if [ ! -f "$DADOS/usuarios.json" ]; then
  passo "Criando o usuário administrador"
  SENHA="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | cut -c1-16)"
  printf '[\n  { "usuario": "admin", "senha": "%s", "admin": true }\n]\n' "$SENHA" > "$DADOS/usuarios.json"
  chmod 600 "$DADOS/usuarios.json"
fi

passo "Liberando a porta $PORTA no firewall do servidor"
if command -v iptables >/dev/null && [ -z "${IPTV_SEM_FIREWALL:-}" ]; then
  # as imagens Ubuntu da Oracle bloqueiam tudo além do SSH; a regra entra antes do bloqueio
  $SUDO iptables -C INPUT -p tcp --dport "$PORTA" -j ACCEPT 2>/dev/null \
    || $SUDO iptables -I INPUT 1 -p tcp --dport "$PORTA" -j ACCEPT
  command -v netfilter-persistent >/dev/null && $SUDO netfilter-persistent save >/dev/null 2>&1 || true
fi
if command -v ufw >/dev/null && $SUDO ufw status 2>/dev/null | grep -q 'Status: active'; then
  $SUDO ufw allow "$PORTA/tcp" >/dev/null
fi

if [ -z "${IPTV_SEM_SYSTEMD:-}" ] && command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
  passo "Deixando o IPTV ligando sozinho (systemd)"
  $SUDO tee /etc/systemd/system/iptv.service >/dev/null <<EOF
[Unit]
Description=IPTV caseiro
After=network-online.target
Wants=network-online.target

[Service]
User=$USUARIO
WorkingDirectory=$APP
Environment=IPTV_RAIZ=$DADOS
Environment=PORT=$PORTA
Environment=HF_HOME=$DADOS/modelos
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable -q iptv
  $SUDO systemctl restart iptv
else
  passo "Sem systemd: ligando em segundo plano (não volta sozinho se o aparelho reiniciar)"
  pkill -f "node server.js" 2>/dev/null || true
  cd "$APP"
  IPTV_RAIZ="$DADOS" PORT="$PORTA" HF_HOME="$DADOS/modelos" nohup node server.js > "$DADOS/iptv.log" 2>&1 < /dev/null &
  cd - >/dev/null
fi

passo "Conferindo se subiu"
for _ in $(seq 1 30); do
  curl -fs "http://127.0.0.1:$PORTA/saude" >/dev/null && break
  sleep 1
done
if ! curl -fs "http://127.0.0.1:$PORTA/saude" >/dev/null; then
  echo "O servidor não respondeu. Veja o motivo com:  sudo journalctl -u iptv -n 50"
  exit 1
fi

IP="$(curl -fs -4 --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
cat <<EOF

✅ IPTV no ar!

  Painel:   http://$IP:$PORTA/admin
  TV:       http://$IP:$PORTA
EOF
if [ -n "$SENHA" ]; then
  cat <<EOF
  Usuário:  admin
  Senha:    $SENHA        ← anote agora (depois: cat $DADOS/usuarios.json)
EOF
fi
cat <<EOF

  No IPTV Smarters Pro → Login with Xtream Codes API:
    URL: http://$IP:$PORTA   ·   usuário e senha acima (ou outro criado no painel)

  Se não abrir de fora: libere a porta $PORTA na Oracle (Lista de segurança da rede,
  regra de entrada TCP $PORTA de 0.0.0.0/0) — veja o README.
  Atualizar no futuro: rode o mesmo comando de instalação de novo.
EOF
