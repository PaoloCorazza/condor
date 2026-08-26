import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const WORKER_NAME = process.env.WORKER_NAME || 'agrimarket-playwright-v3';
const RUN_ONCE = /^(1|true|yes)$/i.test(process.env.RUN_ONCE || '');

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

let stopping = false;
let activeBrowser;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function slugifyQuery(query) {
  return encodeURIComponent(query.trim()).replace(/%20/g, '-');
}

function cleanListingUrl(href) {
  const absolute = new URL(href, 'https://www.olx.pl');
  absolute.search = '';
  absolute.hash = '';
  return absolute.toString();
}

function parseExternalId(url) {
  return url.match(/-(ID[a-zA-Z0-9]+)\.html$/)?.[1] ?? null;
}

function parsePrice(lines) {
  const priceRaw = lines.find((line) => /(?:zł|za darmo|zamienię)/i.test(line)) ?? null;
  if (!priceRaw) return { price_raw: null, price_unit: null, price_pln_kg: null, price_pln_t: null };

  const normalized = priceRaw.replace(/\s/g, '').replace(',', '.');
  const amount = Number(normalized.match(/\d+(?:\.\d+)?/)?.[0]);
  const explicitlyPerKg = /(?:\/|za\s*)kg|kilogram/i.test(priceRaw);
  const explicitlyPerTonne = /(?:\/|za\s*)(?:t|ton|tona|tonę)|tona/i.test(priceRaw);

  if (Number.isFinite(amount) && explicitlyPerKg) {
    return { price_raw: priceRaw, price_unit: 'PLN/kg', price_pln_kg: amount, price_pln_t: amount * 1000 };
  }
  if (Number.isFinite(amount) && explicitlyPerTonne) {
    return { price_raw: priceRaw, price_unit: 'PLN/t', price_pln_kg: amount / 1000, price_pln_t: amount };
  }
  return { price_raw: priceRaw, price_unit: null, price_pln_kg: null, price_pln_t: null };
}

function parseMunicipality(lines) {
  const locationLine = [...lines].reverse().find((line) => line.includes(' - '));
  return locationLine?.split(' - ')[0]?.trim() || null;
}

async function heartbeat(values = {}) {
  const now = new Date().toISOString();
  const { error } = await supabase.from('scraper_worker_state').upsert({
    worker_name: WORKER_NAME,
    last_heartbeat: now,
    updated_at: now,
    ...values,
  }, { onConflict: 'worker_name' });
  if (error) throw error;
}

async function getConfiguration() {
  const [{ data: settings, error: settingsError }, { data: targets, error: targetsError }] = await Promise.all([
    supabase.from('scraper_settings').select('*').eq('id', 1).single(),
    supabase.from('scraper_targets').select('*').eq('enabled', true).eq('source', 'OLX').order('priority').order('id'),
  ]);
  if (settingsError) throw settingsError;
  if (targetsError) throw targetsError;
  return { settings, targets };
}

async function extractCards(page, target, now) {
  const cards = await page.locator('[data-cy="l-card"]').evaluateAll((nodes) => nodes.map((card) => {
    const link = card.querySelector('a[href*="/d/oferta/"]');
    const title = card.querySelector('h4')?.textContent?.trim() || link?.textContent?.trim() || '';
    const lines = (card.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean);
    return { href: link?.getAttribute('href') || '', title, lines };
  }));

  const unique = new Map();
  for (const card of cards) {
    if (!card.href || !card.title) continue;
    const url = cleanListingUrl(card.href);
    if (unique.has(url)) continue;
    const price = parsePrice(card.lines);
    unique.set(url, {
      source: 'OLX',
      external_id: parseExternalId(url),
      observed_at: now,
      product: target.product,
      municipality: parseMunicipality(card.lines),
      comments: card.title,
      url,
      normalization_status: price.price_unit ? 'automatic' : 'unverified',
      data_source: 'OLX Playwright',
      last_seen: now,
      active: true,
      scrape_method: 'playwright',
      source_query: target.search_query,
      ...price,
    });
  }
  return [...unique.values()];
}

async function saveListings(rows, now) {
  if (!rows.length) return { inserted: 0, updated: 0 };
  const urls = rows.map((row) => row.url);
  const { data: existing, error: selectError } = await supabase
    .from('market_listings')
    .select('url,first_seen')
    .eq('source', 'OLX')
    .in('url', urls);
  if (selectError) throw selectError;

  const existingByUrl = new Map((existing ?? []).map((row) => [row.url, row]));
  const payload = rows.map((row) => ({
    ...row,
    first_seen: existingByUrl.get(row.url)?.first_seen || now,
  }));
  const { error: upsertError } = await supabase
    .from('market_listings')
    .upsert(payload, { onConflict: 'source,url' });
  if (upsertError) throw upsertError;

  const updated = payload.filter((row) => existingByUrl.has(row.url)).length;
  return { inserted: payload.length - updated, updated };
}

async function scrapeTarget(browser, target, settings) {
  const startedAt = new Date().toISOString();
  const { data: run, error: runError } = await supabase.from('scrape_runs').insert({
    started_at: startedAt,
    source: 'OLX',
    method: 'playwright',
    query: target.search_query,
    status: 'running',
  }).select('id').single();
  if (runError) throw runError;

  const context = await browser.newContext({
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
  });
  const page = await context.newPage();
  let pagesScanned = 0;
  let listingsSeen = 0;
  let listingsInserted = 0;
  let listingsUpdated = 0;

  try {
    for (let pageNumber = 1; pageNumber <= settings.max_pages_per_query && !stopping; pageNumber += 1) {
      const url = `https://www.olx.pl/oferty/q-${slugifyQuery(target.search_query)}/?page=${pageNumber}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.locator('[data-cy="l-card"]').first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
      const now = new Date().toISOString();
      const rows = await extractCards(page, target, now);
      pagesScanned += 1;
      listingsSeen += rows.length;
      if (!rows.length) break;

      const saved = await saveListings(rows, now);
      listingsInserted += saved.inserted;
      listingsUpdated += saved.updated;
      await heartbeat({ last_status: `running:${target.search_query}`, last_error: null });
      await sleep(settings.request_delay_ms);
    }

    const finishedAt = new Date().toISOString();
    const { error } = await supabase.from('scrape_runs').update({
      finished_at: finishedAt,
      status: 'success',
      pages_scanned: pagesScanned,
      listings_seen: listingsSeen,
      listings_inserted: listingsInserted,
      listings_updated: listingsUpdated,
    }).eq('id', run.id);
    if (error) throw error;
    console.log(JSON.stringify({ event: 'target_complete', query: target.search_query, pagesScanned, listingsSeen, listingsInserted, listingsUpdated }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase.from('scrape_runs').update({
      finished_at: new Date().toISOString(),
      status: 'error',
      pages_scanned: pagesScanned,
      listings_seen: listingsSeen,
      listings_inserted: listingsInserted,
      listings_updated: listingsUpdated,
      error_message: message.slice(0, 4000),
    }).eq('id', run.id);
    throw error;
  } finally {
    await context.close();
  }
}

async function markStaleListings(staleAfterDays) {
  const cutoff = new Date(Date.now() - staleAfterDays * 86_400_000).toISOString();
  const { error } = await supabase.from('market_listings')
    .update({ active: false })
    .eq('source', 'OLX')
    .eq('active', true)
    .lt('last_seen', cutoff);
  if (error) throw error;
}

async function runCycle() {
  const cycleStartedAt = new Date().toISOString();
  await heartbeat({ last_run_started_at: cycleStartedAt, last_status: 'starting', last_error: null });
  const { settings, targets } = await getConfiguration();
  if (!settings.enabled) {
    await heartbeat({ last_status: 'disabled' });
    return settings.interval_minutes;
  }

  activeBrowser = await chromium.launch({
    headless: settings.headless,
    args: ['--disable-dev-shm-usage'],
  });

  let failures = 0;
  try {
    for (const target of targets) {
      if (stopping) break;
      try {
        await scrapeTarget(activeBrowser, target, settings);
      } catch (error) {
        failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ event: 'target_error', query: target.search_query, error: message }));
        await heartbeat({ last_status: `error:${target.search_query}`, last_error: message.slice(0, 4000) });
      }
    }
    await markStaleListings(settings.stale_after_days);
  } finally {
    await activeBrowser.close();
    activeBrowser = undefined;
  }

  const finishedAt = new Date().toISOString();
  await heartbeat({
    last_run_finished_at: finishedAt,
    last_status: failures ? `completed_with_${failures}_errors` : 'success',
    last_error: failures ? `${failures} target(s) failed; inspect scrape_runs` : null,
  });
  return settings.interval_minutes;
}

async function main() {
  console.log(JSON.stringify({ event: 'worker_start', worker: WORKER_NAME, run_once: RUN_ONCE }));
  while (!stopping) {
    let intervalMinutes = 5;
    try {
      intervalMinutes = await runCycle();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: 'cycle_error', error: message }));
      await heartbeat({ last_status: 'error', last_error: message.slice(0, 4000) }).catch(() => {});
    }

    if (RUN_ONCE) break;

    const waitMs = Math.max(1, intervalMinutes) * 60_000;
    const deadline = Date.now() + waitMs;
    while (!stopping && Date.now() < deadline) {
      await sleep(Math.min(30_000, deadline - Date.now()));
      await heartbeat().catch(() => {});
    }
  }
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: 'worker_stop', signal }));
  await activeBrowser?.close().catch(() => {});
}

process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
