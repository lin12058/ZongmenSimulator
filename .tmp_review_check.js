const fs = require('fs');
const { execSync } = require('child_process');

const git = 'C:/Program Files/Git/cmd/git.exe';
const run = function(cmd) {
  try { return execSync('"' + git + '" ' + cmd, { encoding: 'utf8', shell: 'cmd.exe', maxBuffer: 64*1024*1024 }); }
  catch(e) { return 'ERR: ' + e.message.substring(0, 400); }
};

// Diff stat per file over last 2 days against 2 days ago baseline
console.log('==== DIFF STAT vs 2 days ago ====');
console.log(run('diff --stat $(git rev-parse HEAD~8) HEAD -- Server/Zongmen/Engine/js/mapgen.js'));
console.log('==== mapgen.js commit sizes last 2 days ====');
console.log(run('log --oneline --stat --since="2 days ago" -- Server/Zongmen/Engine/js/mapgen.js'));