// Loaded with `node --import` by test/backend.test.js before backend/server.js:
// points the server's Anthropic SDK at the stand-in (loader.mjs).
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
