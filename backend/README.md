# Lot Current rewrite service

A small Node server that asks Claude for a Marketplace description from a JSON object of facts, checks the draft with the same guardrails the extension uses, and returns it. It exists so the Anthropic API key never ships inside the extension.

The extension works without it: descriptions then come from the built-in template. This service only improves the first draft.

## Set up (once)

1. Get an API key at https://console.anthropic.com/ (API keys). Add a small amount of credit; a description costs a fraction of a cent on Haiku 4.5.
2. In this folder:

   ```
   cp .env.example .env      # on Windows: copy .env.example .env
   ```

   Open `.env`, paste the key into `ANTHROPIC_API_KEY`, and set `REWRITE_KEY` to any long random string.
3. Install and start (Node 20 or newer):

   ```
   npm ci
   npm start
   ```

   You should see `Lot Current rewrite service on http://127.0.0.1:8787`. Check it with `http://localhost:8787/health`.
4. In the extension: click the Lot Current icon, **Settings**, **Description writer**. Tick "Use the Lot Current rewrite service", enter `http://localhost:8787` as the address and your `REWRITE_KEY` as the key. Save.

From then on the side panel's first draft comes from Claude, and "Rewrite with Claude" asks for another. Every draft still goes through the guardrails (numbers must match the website, prices and mileage must be the listing's own, banned phrases, dealer name, the salesperson's role, length); a draft that fails is regenerated once, then the template is used.

## Colors from the photos

`POST /color` with `{ "photos": [up to 4 https addresses], "options": [Facebook's color words] }` asks Claude to look at the photos and pick the exterior and interior color from the list, answering `{ ok, exterior, interior, confidence }`. The extension calls it only for a car whose website record gives no usable color, shows the answer as a guess with its confidence, puts it on the form's color fields only (never into the description), and never overrides a color the website does state. Each call is about 4 photos of input, roughly $0.006 on Haiku 4.5.

## Model

`REWRITE_MODEL` in `.env`:

- `claude-haiku-4-5` (default): fast and cheap, good at this job. `claude-haiku-4-5-20251001` pins the dated snapshot.
- `claude-sonnet-5`: better prose, about twice the price.

Current model names and prices: https://docs.claude.com/en/docs/about-claude/models

## Cost and limits

- Each description is roughly 1,500 input tokens and 200 output tokens. On Haiku 4.5 that is about $0.0025, so around $2.50 per 1,000 descriptions; a failed check that triggers a second draft doubles it for that car.
- `MONTHLY_COST_CAP_USD` (default 25) stops the service for the rest of the month once the running total in `usage.json` reaches it. The extension then falls back to the template.
- `RATE_LIMIT_PER_MINUTE` (default 20) is per caller.

## Running it for a whole store

For a pilot it can run on one PC (`npm start` in a terminal) with the extension pointed at `http://localhost:8787`. By default it listens on `127.0.0.1` only, so nothing else on the network can reach it.

To share it, run it on any small Node host (Railway, Fly.io, Render, a VPS) with `HOST=0.0.0.0` and `REWRITE_KEY` set in `.env` (the service refuses to start on any address other than `127.0.0.1` without a key), use https, and give the salespeople the address and key. The key is a pilot-only shared secret: every salesperson has the same one, so if a salesperson leaves, change it in `.env` and on every machine that still has the old one. Milestone 4 replaces it with per-user sign-in (a Supabase Edge Function behind real accounts).

## What it stores

`usage.json` (a running cost total for the month) and nothing else. It logs one line per request with the car's year, make and model. No VIN, no Facebook data and no salesperson data reach this service beyond the sign-off name and title that go into the description.
