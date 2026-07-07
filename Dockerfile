# ── Stage 1: build the React frontend ────────────────────────────────────────
FROM node:20-slim AS frontend-builder

WORKDIR /frontend

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ── Stage 2: Python runtime ───────────────────────────────────────────────────
FROM python:3.12-slim

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
COPY --from=frontend-builder /frontend/dist ./dist

# Config persists to a mounted volume (/data by default).
ENV CONFIG_DIR=/data
VOLUME ["/data"]

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
