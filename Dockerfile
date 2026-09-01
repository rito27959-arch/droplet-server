# ── DropletServer (Railway) ──────────────────────────────────────────
# Serveur de signaling WebRTC + TURN pour les appels audio/vidéo.
# Déployé sur Railway.app
# ─────────────────────────────────────────────────────────────────────

FROM dart:stable-sdk AS build

WORKDIR /app

COPY pubspec.yaml ./
RUN dart pub get

COPY . .

RUN dart compile exe lib/server.dart -o bin/server

# ── Image finale ────────────────────────────────────────────────────
FROM debian:bookworm-slim

COPY --from=build /app/bin/server /app/server

ENV PORT=8082
EXPOSE 8082

ENTRYPOINT ["/app/server"]
