# LottOrakel-Data

All LOTTO 6aus49 draws since 9 October 1955 as JSON, updated automatically after each draw.
Data source of the [LottOrakel](https://github.com/enoks/LottOrakel) app.

**Not an official offer** of LOTTO 6aus49, the DLTB or any state lottery. No guarantee of
correctness – check your ticket with your lottery provider.

## File

[`draws.json`](draws.json) – an array with one object per draw, oldest first, one draw per line:

```json
[
{"id":1,"date":"1955-10-09","numbers":[3,12,13,16,23,41],"superzahl":null},
{"id":5064,"date":"2026-11-14","numbers":[11,15,17,32,39,49],"superzahl":3}
]
```

- `id`: consecutive draw number, starting at 1, without gaps
- `date`: draw date (ISO 8601, Berlin). Saturdays since 1965 (Sundays before, a few Mondays),
  Wednesdays in addition since December 2000
- `numbers`: the 6 drawn numbers (1–49), ascending
- `superzahl`: 0–9, `null` before the Superzahl was introduced (7 December 1991)

New fields may be added to the draw objects; existing ones keep their meaning.

Raw URL: `https://raw.githubusercontent.com/enoks/LottOrakel-Data/main/draws.json`

## Updates

A [GitHub Action](.github/workflows/update.yml), started by an external cron through the GitHub API,
checks lotto.de every 15 minutes on Wednesday 18:30–23:45 and Saturday 19:30–23:45 (Berlin) and
commits new draws ([`scripts/update.mjs`](scripts/update.mjs)): it closes
gaps of up to 10 draws and validates every draw (6 distinct numbers 1–49, Superzahl 0–9,
Wednesday or Saturday). The daily run (05:00, `verify=true`) fails if a draw is still missing the day after; it also
re-checks the last 3 draws against lotto.de and takes over corrections (commit "Correct draw(s) …").

## Sources and license

- Draws until 04.11.2026: [LottoNumberArchive](https://github.com/JohannesFriedrich/LottoNumberArchive)
  by Johannes Friedrich, licensed under LGPL-3.0.
- Later draws: published results on [lotto.de](https://www.lotto.de).

Licensed under the GNU Lesser General Public License v3.0, like the archive it builds on – see
[COPYING.LESSER](COPYING.LESSER) and [COPYING](COPYING).
