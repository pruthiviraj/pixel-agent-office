# Pixel Agent Office — viewer container
# ------------------------------------------------------------------
# This image hosts the OFFICE VIEWER (server.js, port 4040). It does
# NOT bundle the Claude Code CLI, so orchestration workers can't spawn
# inside it — run `node orchestrate.js` on the host (where `claude` is
# installed and authenticated) and mount/share ./data with the container
# if you want the hosted viewer to show a live sprint.
#
#   docker build -t pixel-agent-office .
#   docker run -p 4040:4040 pixel-agent-office                 # demo/viewer
#   docker run -p 4040:4040 -v "$PWD/data:/app/data" pixel-agent-office  # live state from host
FROM node:20-alpine

WORKDIR /app

# Zero npm dependencies — no install step, just the repo.
COPY . .

ENV PORT=4040
EXPOSE 4040

CMD ["node", "server.js"]
