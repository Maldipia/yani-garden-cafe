// ── Surprise rewards: Soul Searcher + Rainy Day ────────────────────────────
// Fire-and-forget. Both check their own settings flag + cooldown.
import { supaFetch, auditLog } from './db.js';
import { SUPABASE_URL } from './config.js';

export async function _maybeFireSoulSearcher(accountId, orderId, sett) {
  if ((sett.SURPRISE_SOUL_SEARCHER_ENABLED || 'true') === 'false') return;
  const visitsNeeded = parseInt(sett.SURPRISE_SOUL_SEARCHER_VISITS         || '5');
  const windowDays   = parseInt(sett.SURPRISE_SOUL_SEARCHER_WINDOW_DAYS    || '30');
  const cooldownDays = parseInt(sett.SURPRISE_SOUL_SEARCHER_COOLDOWN_DAYS  || '30');
  const expiryDays   = parseInt(sett.SURPRISE_REWARD_EXPIRY_DAYS           || '30');

  // Count EARN transactions in the last `windowDays` days
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();
  const earnsR = await supaFetch(
    `${SUPABASE_URL}/rest/v1/points_transactions?account_id=eq.${encodeURIComponent(accountId)}&type=eq.EARN&created_at=gte.${encodeURIComponent(since)}&select=order_id`
  );
  if (!earnsR.ok) return;
  // Count UNIQUE order_ids — protects against accidental double-EARNs on
  // the same order (shouldn't happen, but cheap defense)
  const uniqueOrders = new Set((earnsR.data || []).map(r => r.order_id).filter(Boolean));
  if (uniqueOrders.size < visitsNeeded) return;

  // Cooldown check — has Soul Searcher already fired in last `cooldownDays`?
  const cdSince = new Date(Date.now() - cooldownDays * 24 * 3600 * 1000).toISOString();
  const recentR = await supaFetch(
    `${SUPABASE_URL}/rest/v1/surprise_rewards?account_id=eq.${encodeURIComponent(accountId)}&reward_type=eq.SOUL_SEARCHER&triggered_at=gte.${encodeURIComponent(cdSince)}&select=id&limit=1`
  );
  if (recentR.ok && recentR.data && recentR.data.length > 0) return;

  // Fire it
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 3600 * 1000).toISOString();
  await supaFetch(`${SUPABASE_URL}/rest/v1/surprise_rewards`, {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      account_id:             accountId,
      reward_type:            'SOUL_SEARCHER',
      reward_name:            'Free Drink Upgrade',
      reward_value:           'FREE_DRINK_UPGRADE',
      status:                 'PENDING',
      triggered_by_order_id:  orderId,
      expires_at:             expiresAt,
      notes:                  `${uniqueOrders.size} visits in last ${windowDays} days`,
    })
  });
  await auditLog({ orderId, action: 'SURPRISE_SOUL_SEARCHER', details: { accountId, visits: uniqueOrders.size, windowDays } });
}

// Rainy Day: needs weather data. Looks at weather_cache for today's PHT date;
// if missing, queries OpenWeatherMap (free tier) and caches the result. If
// WEATHER_API_KEY env var is unset, the whole feature is dormant.
export async function _maybeFireRainyDay(accountId, orderId, sett) {
  if ((sett.SURPRISE_RAINY_DAY_ENABLED || 'true') === 'false') return;
  const apiKey = process.env.WEATHER_API_KEY || process.env.OPENWEATHERMAP_API_KEY;
  if (!apiKey) return; // dormant until owner adds the key

  const threshold = parseFloat(sett.SURPRISE_RAINY_DAY_PRECIP_MM || '1.0');
  const expiryDays = parseInt(sett.SURPRISE_REWARD_EXPIRY_DAYS  || '30');

  // PHT date (Asia/Manila, UTC+8)
  const phtDate = new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10);

  // Check cache
  let precipMm = null;
  let conditions = null;
  const cacheR = await supaFetch(`${SUPABASE_URL}/rest/v1/weather_cache?cache_date=eq.${phtDate}&select=precipitation_mm,conditions&limit=1`);
  if (cacheR.ok && cacheR.data && cacheR.data.length > 0) {
    precipMm   = cacheR.data[0].precipitation_mm;
    conditions = cacheR.data[0].conditions;
  } else {
    // Fetch from OpenWeatherMap (current weather endpoint, free tier)
    const lat = sett.WEATHER_LAT || '14.1747';
    const lon = sett.WEATHER_LON || '120.9243';
    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`;
      const wr  = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (wr.ok) {
        const wd = await wr.json();
        // OpenWeatherMap puts rain in wd.rain['1h'] or wd.rain['3h'] (mm)
        precipMm   = (wd.rain && (wd.rain['1h'] || wd.rain['3h'])) || 0;
        conditions = (wd.weather && wd.weather[0] && wd.weather[0].main) || 'Unknown';
        // Cache result for the rest of the day
        await supaFetch(`${SUPABASE_URL}/rest/v1/weather_cache`, {
          method: 'POST',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            cache_date:       phtDate,
            location:         sett.WEATHER_CITY || 'Amadeo,PH',
            precipitation_mm: precipMm,
            conditions:       conditions,
            raw_response:     wd,
          })
        });
      } else {
        // Insert a NULL row so we don't retry on every order today
        await supaFetch(`${SUPABASE_URL}/rest/v1/weather_cache`, {
          method: 'POST', headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({ cache_date: phtDate, precipitation_mm: null, conditions: 'API_ERROR' })
        });
        return;
      }
    } catch (e) {
      console.error('Weather fetch error:', e.message);
      return;
    }
  }

  if (precipMm == null || precipMm < threshold) return;

  // One Rainy Day reward per account per PHT date
  const todayStart = phtDate + 'T00:00:00+08:00';
  const dupR = await supaFetch(
    `${SUPABASE_URL}/rest/v1/surprise_rewards?account_id=eq.${encodeURIComponent(accountId)}&reward_type=eq.RAINY_DAY&triggered_at=gte.${encodeURIComponent(todayStart)}&select=id&limit=1`
  );
  if (dupR.ok && dupR.data && dupR.data.length > 0) return;

  const expiresAt = new Date(Date.now() + expiryDays * 24 * 3600 * 1000).toISOString();
  await supaFetch(`${SUPABASE_URL}/rest/v1/surprise_rewards`, {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      account_id:             accountId,
      reward_type:            'RAINY_DAY',
      reward_name:            'Free Luntian Pastry',
      reward_value:           'FREE_LUNTIAN_PASTRY',
      status:                 'PENDING',
      triggered_by_order_id:  orderId,
      expires_at:             expiresAt,
      notes:                  `Rain ${precipMm}mm (${conditions || 'rainy'}) on ${phtDate}`,
    })
  });
  await auditLog({ orderId, action: 'SURPRISE_RAINY_DAY', details: { accountId, precipMm, conditions, date: phtDate } });
}

