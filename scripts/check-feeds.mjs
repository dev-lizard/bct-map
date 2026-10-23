// Quick health check of BCT's live feeds: status, freshness and which optional fields are filled.
// Run it when the map looks wrong, before debugging the app.
import { BCT_FEEDS, fetchFeed } from '../server/bct-feed.mjs';

const now = Date.now() / 1000;
for (const [name, url] of Object.entries(BCT_FEEDS)) {
  try {
    const feed = await fetchFeed(url);
    const entities = feed.entity ?? [];
    const age = Math.round(now - Number(feed.header.timestamp));
    console.log(`${name}: ${entities.length} entities, header ${age}s old`);
    if (name === 'vehiclePositions') {
      const v = entities.map(e => e.vehicle).filter(Boolean);
      const count = pred => v.filter(pred).length;
      const ages = v.map(x => now - Number(x.timestamp)).sort((a, b) => a - b);
      console.log(`  with trip_id ${count(x => x.trip?.tripId)}, bearing ${count(x => x.position?.bearing != null)}, speed ${count(x => x.position?.speed != null)}`);
      if (ages.length) console.log(`  report age: median ${Math.round(ages[ages.length >> 1])}s, max ${Math.round(ages.at(-1))}s`);
    }
    if (name === 'tripUpdates') {
      const u = entities.map(e => e.tripUpdate).filter(Boolean);
      console.log(`  canceled ${u.filter(x => x.trip?.scheduleRelationship === 'CANCELED').length}, with delay field ${u.filter(x => x.delay != null).length}`);
    }
  } catch (err) {
    console.log(`${name}: FAILED - ${err.message}`);
    process.exitCode = 1;
  }
}
