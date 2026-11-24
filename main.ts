// ISLA BRASA 3D — entrypoint for make.fun, round 6 (Node 22, standard library only).
//
// The game is plain static files under game/ in this repository: game/index.html
// plus its ES modules, with Three.js vendored locally at
// game/vendor/three.module.min.js and mapped by the import map in
// game/index.html, so the game loads with no network request at all.
//
// This program is the hand-in: it copies game/ and screenshots/ from beside
// this file into the output directory and writes /output/dossier.json there,
// using the dossier builder in vendor/makefun-game.ts. The dossier is the
// summary the judge reads.
//
// Run it locally to check the hand-in before anyone submits it:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// With MAKEFUN_OUTPUT_DIR unset the grader's /output is used instead.
// To play the game itself, run `node serve.ts` and open http://localhost:8080.
//
// I wrote this file fresh for the gta6-06 rebuild. Its shape follows the
// kit starter (copy the two trees, build the dossier with the same caps),
// but every line and comment here is my own wording.

import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

// This file lives at the repository root, so its directory is the repo root.
const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fail loudly and early when the game page is missing: without
// game/index.html there is no entry, and a half-empty /output helps nobody.
const gameDir = join(repoRoot, 'game');
const indexPath = join(gameDir, 'index.html');
if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
  throw new Error('main.ts: game/index.html is missing — nothing to hand in');
}

mkdirSync(outDir, { recursive: true });
cpSync(gameDir, join(outDir, 'game'), { recursive: true });

// Screenshots live in screenshots/ and were taken by the game's maker. The
// dossier builder refuses an entry with none, so a missing directory is an
// error here instead of a silent empty folder in the output.
const shotsDir = join(repoRoot, 'screenshots');
mkdirSync(join(outDir, 'screenshots'), { recursive: true });
if (existsSync(shotsDir)) {
  cpSync(shotsDir, join(outDir, 'screenshots'), { recursive: true });
}

// The scorer's own caps. Only text_max_bytes shapes the dossier bytes; the
// rest refuse an entry the scorer would refuse anyway (more than 4
// screenshots, or one over 256 KiB; more than 993 entries in game/, or 48 MiB
// of game files, or a game path over 1000 bytes). Passing them here makes
// this program fail in exactly the places the scorer would, while there is
// still time to fix it.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);

console.log(`ISLA BRASA 3D (gta6-06) handed in: ${outDir}`);
