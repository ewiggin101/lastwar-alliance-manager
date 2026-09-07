# OCR sample screenshots

Reference screenshots of the in-game screens the app parses. Drop new samples
into the matching subfolder (upload via the GitHub web UI, then `git pull` on
whatever box does the OCR work).

- `vs/` — VS ranking screen (daily duel points)
- `desert-storm/` — Desert Storm results (per-member damage, 2 alliances)
- `canyon-storm/` — Canyon Storm results (1 vs 2 alliances, 3 total)

More samples per screen is better: different scroll positions, row counts, and
name lengths all exercise the parser.

Image files here are tracked on purpose (see the carve-out at the bottom of
`.gitignore`); keep them reasonably sized.
