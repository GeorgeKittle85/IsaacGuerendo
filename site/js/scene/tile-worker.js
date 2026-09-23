// Tile worker: fetches, decompresses and prepares scenery tiles off the main
// thread (see tiledata.js), then hands the typed arrays back without copying.

import { fetchGz, prepareTile, transferList } from "./tiledata.js";

self.onmessage = async (e) => {
  const { id, url } = e.data;
  try {
    const prep = prepareTile(await fetchGz(url));
    self.postMessage({ id, prep }, transferList(prep));
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
