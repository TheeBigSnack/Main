// Files a packed extension must not carry: editor and OS leftovers, and the
// adapter contract (a developer's document that no shipped code reads). The
// pack (scripts/pack.mjs) and the store preflight (scripts/store-check.mjs)
// both use this one rule, so the preflight never calls a correct zip incomplete.
export const SKIP = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|.*\.swp|.*~)$|^adapters\/README\.md$/;
