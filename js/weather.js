// Weather from Open-Meteo (free, no API key, no account). Only the chosen coordinates are sent.
import { settings, saveSettings } from './store.js';

const WK = 'ppp-weather-v1';
const FRESH_MS = 30 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;

let cache = (() => { try { return JSON.parse(localStorage.getItem(WK)); } catch { return null; } })();
let inflight = false;
let lastFail = 0;
export let weatherError = '';
export let searchResults = null; // [{ name, lat, lon }] after a city search
let onUpdate = () => {};
export const setWeatherListener = (fn) => { onUpdate = fn; };

const IMPERIAL_REGIONS = ['US', 'LR', 'MM'];
export function units() {
  if (settings.units === 'metric' || settings.units === 'imperial') return settings.units;
  const region = (navigator.language || '').split('-')[1]?.toUpperCase();
  return IMPERIAL_REGIONS.includes(region) ? 'imperial' : 'metric';
}

const keyOf = (loc) => `${(+loc.lat).toFixed(3)},${(+loc.lon).toFixed(3)},${units()}`;

/** Cached weather for the saved location (refreshes in the background when old). null = nothing yet. */
export function getWeather() {
  const loc = settings.weatherLoc;
  if (!loc) return null;
  const k = keyOf(loc);
  const c = cache?.key === k ? cache : null;
  if (!c || Date.now() - c.ts > FRESH_MS) refresh(loc, k);
  return c ? { ...c.data, ts: c.ts } : null;
}

async function refresh(loc, k) {
  if (inflight || !navigator.onLine || Date.now() - lastFail < RETRY_MS) return;
  inflight = true;
  try {
    const imp = units() === 'imperial';
    const q = new URLSearchParams({
      latitude: loc.lat, longitude: loc.lon, timezone: 'auto', forecast_days: '6',
      current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,relative_humidity_2m',
      hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max',
      ...(imp ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' } : {}),
    });
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
    if (!r.ok) throw new Error(`Weather service error ${r.status}`);
    cache = { key: k, ts: Date.now(), data: shape(await r.json(), imp) };
    try { localStorage.setItem(WK, JSON.stringify(cache)); } catch { /* quota */ }
    weatherError = '';
  } catch (e) {
    lastFail = Date.now();
    weatherError = navigator.onLine ? e.message || 'Could not load the weather' : 'Offline';
  } finally {
    inflight = false;
    onUpdate();
  }
}

function shape(j, imp) {
  const c = j.current || {};
  const h = j.hourly || {};
  const d = j.daily || {};
  const nowHour = String(c.time || '').slice(0, 13);
  let i0 = (h.time || []).findIndex((t) => t.slice(0, 13) === nowHour);
  if (i0 < 0) i0 = 0;
  const hourly = (h.time || []).slice(i0, i0 + 13).map((t, k) => ({
    time: t.slice(11, 16), temp: h.temperature_2m[i0 + k], code: h.weather_code[i0 + k],
    pop: h.precipitation_probability?.[i0 + k] ?? null, isDay: !!h.is_day?.[i0 + k],
  }));
  const daily = (d.time || []).map((date, k) => ({
    date, code: d.weather_code[k], max: d.temperature_2m_max[k], min: d.temperature_2m_min[k],
    pop: d.precipitation_probability_max?.[k] ?? null, sunrise: d.sunrise?.[k]?.slice(11, 16), sunset: d.sunset?.[k]?.slice(11, 16),
    uv: d.uv_index_max?.[k] ?? null,
  }));
  return {
    now: {
      temp: c.temperature_2m, feels: c.apparent_temperature, code: c.weather_code, isDay: !!c.is_day,
      wind: c.wind_speed_10m, humidity: c.relative_humidity_2m,
    },
    hourly, daily, unit: imp ? '°F' : '°C', windUnit: imp ? 'mph' : 'km/h',
  };
}

/* ---------- Picking a location ---------- */
export async function searchPlaces(q) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: q, count: '6', language: navigator.language?.split('-')[0] || 'en', format: 'json' })}`);
  if (!r.ok) throw new Error('Search failed');
  const j = await r.json();
  searchResults = (j.results || []).map((p) => ({
    name: [p.name, p.admin1 && p.admin1 !== p.name ? p.admin1 : '', p.country_code].filter(Boolean).join(', '),
    short: p.name, lat: p.latitude, lon: p.longitude,
  }));
  onUpdate();
  return searchResults;
}

export function pickPlace(i) {
  const p = searchResults?.[i];
  if (!p) return;
  searchResults = null;
  setLocation({ name: p.short, full: p.name, lat: p.lat, lon: p.lon });
}

export function useMyLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Location is not available in this browser')); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocation({ name: 'Current location', lat: +pos.coords.latitude.toFixed(3), lon: +pos.coords.longitude.toFixed(3) }); resolve(); },
      (err) => reject(new Error(err.code === 1 ? 'Location permission was denied. Search for your city instead.' : 'Could not get your location')),
      { timeout: 15000, maximumAge: 6 * 3600 * 1000 },
    );
  });
}

function setLocation(loc) {
  weatherError = '';
  lastFail = 0;
  saveSettings({ weatherLoc: loc });
}

export function clearLocation() {
  searchResults = null;
  saveSettings({ weatherLoc: null });
}

/* ---------- WMO weather codes ---------- */
const CODES = {
  0: ['Clear', '☀️', '🌙'], 1: ['Mostly clear', '🌤️', '🌙'], 2: ['Partly cloudy', '⛅', '☁️'], 3: ['Cloudy', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Heavy showers', '🌧️'],
  85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Thunderstorm, hail', '⛈️'],
};
export const wxLabel = (code) => CODES[code]?.[0] || '—';
export const wxIcon = (code, isDay = true) => { const c = CODES[code]; return c ? (!isDay && c[2]) || c[1] : '🌡️'; };
export const isWet = (code) => code >= 51;
