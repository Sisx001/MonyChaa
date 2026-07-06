'use strict';
// Weather via OpenWeatherMap (key) or open-meteo (keyless fallback).
const config = require('../config');

async function getWeather(location) {
  if (config.key('WEATHER_API_KEY')) {
    const res = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&units=metric&appid=${config.key('WEATHER_API_KEY')}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) throw new Error(`weather HTTP ${res.status}`);
    const j = await res.json();
    return `${j.name}: ${j.weather?.[0]?.description}, ${Math.round(j.main.temp)}°C (feels ${Math.round(j.main.feels_like)}°C), humidity ${j.main.humidity}%`;
  }
  // Keyless fallback: geocode + forecast via open-meteo.
  const geo = await (await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
    { signal: AbortSignal.timeout(10000) }
  )).json();
  const place = geo.results?.[0];
  if (!place) throw new Error(`Unknown location: ${location}`);
  const wx = await (await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m`,
    { signal: AbortSignal.timeout(10000) }
  )).json();
  const c = wx.current;
  return `${place.name}: ${c.temperature_2m}°C, humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h`;
}

module.exports = { getWeather };
