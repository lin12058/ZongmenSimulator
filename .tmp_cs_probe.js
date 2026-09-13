const fs = require('fs');
const cs = fs.readFileSync('Server/Zongmen/Services/MapWorldService.cs', 'utf8');
const lines = cs.split('\n');
console.log('=== roadVer / tile freshness lines ===');
lines.forEach((l, i) => { if (/roadVer|RoadVer|tileRev|TileRev|rev|Rev/.test(l)) console.log((i + 1) + ': ' + l.trim().substring(0, 140)); });
console.log('\n=== Store/batch/backfill mentions ===');
lines.forEach((l, i) => { if (/Store\(|Batch|WriteBack|250ms|flush|Flush|blockingtile/i.test(l)) console.log((i + 1) + ': ' + l.trim().substring(0, 140)); });