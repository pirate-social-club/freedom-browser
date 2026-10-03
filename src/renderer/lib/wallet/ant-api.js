/**
 * Shared Bee API fetch helper.
 */

import { buildAntUrl } from '../state.js';

export async function fetchAntJson(endpoint) {
  const response = await fetch(buildAntUrl(endpoint));
  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  return { ok: response.ok, status: response.status, data };
}
