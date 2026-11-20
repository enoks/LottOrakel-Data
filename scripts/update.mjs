// Adds missing LOTTO 6aus49 draws from lotto.de to draws.json. With VERIFY=1 (daily run) it also
// re-checks the last VERIFY_COUNT draws and takes over corrections from lotto.de.
// Exit codes: 0 = up to date or updated, also on transient network errors (the next run retries);
// 1 = invalid data or the file is stale (a draw is missing since yesterday) -> GitHub mails the failure.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const FILE = new URL('../draws.json', import.meta.url);
const LATEST_URL = 'https://www.lotto.de/api/stats/entities.lotto/last';
const DRAW_URL = 'https://www.lotto.de/api/stats/entities.lotto/draws';
const MAX_GAP = 10; // more missing draws than this: something is off, don't guess
const VERIFY_COUNT = 3;
const PAUSE_MS = 3000; // lotto.de (Cloudflare) answers 429 to quick repeats
const TZ = 'Europe/Berlin';
const DAY = 86_400_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ISO date (yyyy-mm-dd) and hour of an instant in Berlin time; en-CA formats dates as ISO.
const berlinDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const berlinHour = (ms) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' })
  .formatToParts(ms).find((p) => p.type === 'hour').value);

// Evening runs ask lotto.de only from here on (Berlin, minutes after midnight), Wed / Sat.
const WINDOW_FROM = { 3: 18 * 60 + 30, 6: 19 * 60 + 30 };

const utcDay = (iso) => Date.parse(`${iso}T00:00:00Z`);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const weekday = (iso) => new Date(utcDay(iso)).getUTCDay(); // 3 = Wed, 6 = Sat
const isDrawDay = (iso) => [3, 6].includes(weekday(iso));

// Previous scheduled draw (Wed <-> Sat).
const previousDrawDate = (iso) => isoDay(utcDay(iso) - (weekday(iso) === 6 ? 3 : 4) * DAY);

// lotto.de keys draws by Berlin midnight (UTC+1 or +2).
function berlinMidnight(iso) {
  for (const offsetH of [1, 2]) {
    const ms = utcDay(iso) - offsetH * 3_600_000;
    if (berlinDate(ms) === iso && berlinHour(ms) === 0) return ms;
  }
  throw new Error(`no Berlin midnight for ${iso}`);
}

// Draw day in Berlin and past the window start. Guards lotto.de against a misconfigured external cron
// (e.g. one running in UTC).
function inEveningWindow(now) {
  const from = WINDOW_FROM[weekday(berlinDate(now))];
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(now).split(':').map(Number);
  return from !== undefined && h * 60 + m >= from;
}

class TransientError extends Error {}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new TransientError(`${url}: ${e.message}`);
  }
  if (res.status === 429 || res.status >= 500) throw new TransientError(`${url}: HTTP ${res.status}`);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// Structural checks only; the apps validate draws.json again (parseDraws).
function parseDraw(payload) {
  const date = berlinDate(payload.drawDate);
  if (!isDrawDay(date)) throw new Error(`unexpected weekday for ${date}`);
  const numbers = [...(payload.drawNumbersCollection ?? [])].sort((a, b) => a.index - b.index).map((n) => n.drawNumber);
  if (numbers.length !== 6 || new Set(numbers).size !== 6 || numbers.some((n) => !Number.isInteger(n) || n < 1 || n > 49)) {
    throw new Error(`invalid numbers ${JSON.stringify(numbers)} for ${date}`);
  }
  const superzahl = payload.superNumber;
  if (!Number.isInteger(superzahl) || superzahl < 0 || superzahl > 9) throw new Error(`invalid superzahl ${superzahl} for ${date}`);
  return { date, numbers: numbers.sort((a, b) => a - b), superzahl };
}

// One draw per line: valid JSON with one-line git diffs.
const serialize = (draws) => `[\n${draws.map((d) => JSON.stringify(d)).join(',\n')}\n]\n`;

function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

// Most recent draw date strictly before today (Berlin): it must be in the file by now.
function lastDueDraw(now) {
  let ms = utcDay(berlinDate(now)) - DAY;
  while (!isDrawDay(isoDay(ms))) ms -= DAY;
  return isoDay(ms);
}

async function fetchMissing(known) {
  // Today's draw already in: nothing to ask lotto.de.
  if (known.has(berlinDate(Date.now()))) return [];

  const latest = parseDraw(await getJson(LATEST_URL));
  if (known.has(latest.date)) return [];

  const missing = [latest.date];
  for (let prev = previousDrawDate(latest.date); !known.has(prev); prev = previousDrawDate(prev)) {
    if (missing.length >= MAX_GAP) throw new Error(`more than ${MAX_GAP} draws missing before ${latest.date}`);
    missing.unshift(prev);
  }

  const result = [];
  for (const date of missing) {
    result.push(date === latest.date ? latest : await fetchDrawOn(date));
  }
  return result;
}

async function fetchDrawOn(date) {
  await sleep(PAUSE_MS);
  const draw = parseDraw((await getJson(`${DRAW_URL}/${berlinMidnight(date)}`))[0]);
  if (draw.date !== date) throw new Error(`asked lotto.de for ${date}, got ${draw.date}`);
  return draw;
}

const sameDraw = (a, b) => a.superzahl === b.superzahl && a.numbers.join() === b.numbers.join();

// Re-fetches the last VERIFY_COUNT draws; returns the corrected ones (fixed in place in `draws`).
async function verifyLast(draws) {
  const corrected = [];
  for (const stored of draws.slice(-VERIFY_COUNT)) {
    const fresh = await fetchDrawOn(stored.date);
    if (sameDraw(stored, fresh)) continue;
    console.log(`::warning::lotto.de differs for ${stored.date}: `
      + `${stored.numbers.join(' ')} | SZ ${stored.superzahl} -> ${fresh.numbers.join(' ')} | SZ ${fresh.superzahl}`);
    Object.assign(stored, { numbers: fresh.numbers, superzahl: fresh.superzahl });
    corrected.push(stored);
  }
  return corrected;
}

// Transient errors (network, 429, 5xx) are left to the next run.
async function attempt(fn, fallback) {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof TransientError)) throw e;
    console.log(`::warning::lotto.de not reachable, next run retries: ${e.message}`);
    return fallback;
  }
}

const draws = JSON.parse(readFileSync(FILE, 'utf8'));
// The daily run and manual starts (VERIFY=1) always look; evening runs only inside the Berlin window.
const askLottoDe = process.env.VERIFY === '1' || inEveningWindow(Date.now());
const added = askLottoDe ? await attempt(() => fetchMissing(new Set(draws.map((d) => d.date))), []) : [];

let id = draws.at(-1).id;
for (const d of added) {
  id += 1;
  draws.push({ id, date: d.date, numbers: d.numbers, superzahl: d.superzahl });
  summary(`Added #${id} ${d.date}: ${d.numbers.join(' ')} | SZ ${d.superzahl}`);
}
if (!askLottoDe) summary('Outside the draw window (Berlin), lotto.de not asked.');
else if (!added.length) summary('No new draw.');

// After adding, so a draw added in this run is checked too.
const corrected = process.env.VERIFY === '1' ? await attempt(() => verifyLast(draws), []) : [];
for (const d of corrected) summary(`Corrected #${d.id} ${d.date}: ${d.numbers.join(' ')} | SZ ${d.superzahl}`);
if (process.env.VERIFY === '1' && !corrected.length) summary(`Last ${VERIFY_COUNT} draws match lotto.de.`);

if (added.length || corrected.length) {
  writeFileSync(FILE, serialize(draws));
  const message = [
    added.length && `Add draw(s) ${added.map((d) => d.date).join(', ')}`,
    corrected.length && `Correct draw(s) ${corrected.map((d) => d.date).join(', ')}`,
  ].filter(Boolean).join('; ');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `message=${message}\n`);
}

const due = lastDueDraw(Date.now());
if (draws.at(-1).date < due) {
  console.log(`::error::Stale: last draw in file is ${draws.at(-1).date}, the one from ${due} is missing.`);
  process.exit(1);
}
