# Moments — Wails (Go) toolchain image
# All migration/conversion work (go, wails CLI, npm, builds, headless webview
# checks) runs in this container — never on the host. See WAILS_MIGRATION_PLAN.md.
#
# Build:  docker build -t moments-wails .
# Shell:  docker run --rm -it -v "$PWD":/app -w /app moments-wails bash
#
# NOTE: unverified until first `docker build` (needs network + time). The
# webkit2gtk version differs by Debian release: bookworm ships 4.1
# (libwebkit2gtk-4.1-dev); older releases use 4.0. Wails detects either.

FROM golang:1.23-bookworm

# ── Native deps for Wails (GTK3 + WebKitGTK) + headless render (xvfb) ─────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config ca-certificates curl git \
      libgtk-3-dev libwebkit2gtk-4.1-dev \
      xvfb xauth \
      nsis \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 24 (Vite/React frontend build) ───────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Wails CLI ─────────────────────────────────────────────────────────────────
ENV GOBIN=/usr/local/bin
RUN go install github.com/wailsapp/wails/v2/cmd/wails@latest \
    && wails version || true

WORKDIR /app

# `wails doctor` should report GTK3 + WebKitGTK present:
#   docker run --rm -v "$PWD":/app -w /app moments-wails wails doctor
