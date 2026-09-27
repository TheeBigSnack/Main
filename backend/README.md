# Lot Sync rewrite service

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
   npm install
   npm start
   ```

   You should see `Lot Sync rewrite service on http://localhost:8787`. Check it with `http://localhost:8787/health`.
4. In the extension: click the Lot Sync icon, **Settings**, **Description writer**. Tick "Use the Lot Sync rewrite service", enter `http://localhost:8787` as the address and your `REWRITE_KEY` as the key. Save.

From then on the side panel's first draft comes from Claude, and "Rewrite with Claude" asks for another. Every draft still goes through the guardrails (numbers must match the website, banned phrases, dealer name, length); a draft that fails is regenerated once, then the template is used.

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

For a pilot it can run on one PC (`npm start` in a terminal) with the extension pointed at `http://localhost:8787`. To share it, run it on any small Node host (Railway, Fly.io, Render, a VPS), set `REWRITE_KEY`, use https, and give the salespeople the address and key. Milestone 4 replaces this with a Supabase Edge Function behind real sign-in.

## What it stores

`usage.json` (a running cost total for the month) and nothing else. It logs one line per request with the car's year, make and model. No VIN, no Facebook data and no salesperson data reach this service beyond the sign-off name and title that go into the description.
