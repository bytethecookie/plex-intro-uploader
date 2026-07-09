# Plex Intro Uploader

A self-hosted tool that scans your Plex TV library for intro markers and bulk-submits them to [IntroDB](https://introdb.app) — helping build a community-powered database of intro timestamps that benefits everyone using apps like Nuvio, Infuse, and Jellyfin.

It finds every episode Plex has already detected an intro for, matches them to IMDB IDs via TMDB, and lets you review and submit them in bulk with a simple web UI.

---

> ⚠️ **Disclaimer: This project is fully vibe-coded.**
>
> It was built entirely with AI assistance and is provided as-is, with absolutely no warranty, guarantee, or liability of any kind. By using this tool you accept that:
>
> - It may break at any time and without notice
> - The author accepts **no liability whatsoever** for any consequences of its use, including but not limited to data loss, API bans, or incorrect timestamp submissions
> - You are responsible for ensuring your use complies with the terms of service of Plex, IntroDB, TMDB, and any other services involved
> - Your API keys are stored locally on your own machine and are your responsibility to keep secure
> - This project is not affiliated with Plex, IntroDB, or TMDB

---

## Prerequisites

- Docker
- A [Plex Media Server](https://www.plex.tv/) with intro markers already scanned
- A [TMDB API key](https://www.themoviedb.org/settings/api) (free)
- An [IntroDB API key](https://introdb.app) (free, format: `idb_...`)

## Running with Docker

```bash
docker run -d \
  -p 8080:8000 \
  -v plex-uploader-data:/data \
  --name plex-intro-uploader \
  ghcr.io/bytethecookie/plex-intro-uploader:latest
```

Then open [http://localhost:8080](http://localhost:8080) in your browser.

Or with Docker Compose — create a `docker-compose.yml`:

```yaml
services:
  plex-intro-uploader:
    image: ghcr.io/bytethecookie/plex-intro-uploader:latest
    ports:
      - "8080:8000"
    volumes:
      - plex-uploader-data:/data
    restart: unless-stopped

volumes:
  plex-uploader-data:
```

Then run `docker compose up -d`.

## Configuration

On first run, open the app and enter your credentials in the Settings section:

- **Plex URL** — e.g. `http://192.168.1.100:32400`
- **Plex Token** — find yours [here](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)
- **TMDB API Key** — from [themoviedb.org](https://www.themoviedb.org/settings/api)
- **IntroDB API Key** — from [introdb.app](https://introdb.app) (format: `idb_...`)
- **Library Name** — the exact name of your TV shows library in Plex

Click **Save** — your config persists in the mounted Docker volume across restarts and image updates.

## Usage

1. Click **Scan** — the tool scans your Plex library for episodes with intro markers and resolves their IMDB IDs
2. Review the results table — select by show, season, or individual episode
3. Click **Submit Selected** — submissions are sent with automatic rate-limit backoff and live progress
4. Use **Retry Failed** to resubmit anything that was rate-limited or errored

## Building from Source

```bash
git clone https://github.com/bytethecookie/plex-intro-uploader
cd plex-intro-uploader
docker compose up --build
```
