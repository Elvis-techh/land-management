#!/usr/bin/env bash
# One-time setup for a new codespace. See devcontainer.json.
set -euo pipefail

# Development settings only. Existing .env files are left alone.
[ -f backend/.env ] || cp backend/.env.example backend/.env
[ -f frontend/.env ] || cp frontend/.env.example frontend/.env

npm install
npm run db:migrate
npm run db:seed
