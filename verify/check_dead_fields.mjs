/* ============================================================
 * check_dead_fields.mjs — 死字段清理的回归守卫
 * ------------------------------------------------------------
 * 2026-11-26 清理清单（用户「都清理」）：
 *   · TickJob.Payload / ScheduleSeq / SortKey / Clone()  —— 零引用/零业务读取
 *   · PlayerSectEntry.ExpireTs —— 表里无此列，Load 回来恒 0（半死字段）
 *
 * 本判据**只做静态守卫**（不需要起服务、不需要 V8）：
 *   ① 被删的东西不许偷偷加回来；
 *   ② 协议层该留的必须留着（SettlementDto.ExpireTs 是 protobuf 字段 12，
 *      web/js/pb.js 会解它 —— 误删会让前端解析错位）。
 *
 * ⚠ 剥注释后再判，避免注释里的字样误命中（工程教训）。
 *
 * 用法: node verify/check_dead_fields.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else { failures++; console.log(`  ✘ ${name}${detail ? '  → ' + detail : ''}`); }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 剥掉 // 行注释、/* *\/ 块注释、以及 XML doc 的 /// 行；
 *  ⚠ 保守：只剥以 /// 或 // 开头的整行，块注释整段剥。 */
function codeOnly(rel) {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/\/.*$/gm, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

console.log('\n== A. 已删的死字段不许回来 ==');
{
  const tj = codeOnly('Server/Zongmen/Time/TickJob.cs');
  check('A1 TickJob 无 Payload 属性', !/\bPayload\b/.test(tj));
  check('A2 TickJob 无 ScheduleSeq', !/\bScheduleSeq\b/.test(tj));
  check('A3 TickJob 无 SortKey', !/\bSortKey\b/.test(tj));
  check('A4 TickJob 无 Clone()', !/\bClone\s*\(/.test(tj));
  check('A5 TickJob 仍有 DtTicks / DueTick（这两个是活的，别误删）',
    /\bDtTicks\b/.test(tj) && /\bDueTick\b/.test(tj));

  const q = codeOnly('Server/Zongmen/Time/ConcurrentTickQueue.cs');
  check('A6 队列不再给 job 写调度序号', !/job\.ScheduleSeq\s*=/.test(q));

  const reg = codeOnly('Server/Zongmen/Time/TickJobRegistry.cs');
  check('A7 NewJob 签名不再有 payload 参数', !/byte\[\]\?\s*payload/.test(reg));

  const store = codeOnly('Server/Zongmen/Time/TickJobStore.cs');
  check('A8 TickJobStore 的 SQL 里不再出现 Payload 列',
    !/\bPayload\b/.test(store));
}

console.log('\n== B. 半死字段 ExpireTs 已从内部实体移除 ==');
{
  const ps = codeOnly('Server/Zongmen/Storage/PlayerSectStore.cs');
  check('B1 PlayerSectEntry 无 ExpireTs 字段', !/\bExpireTs\b/.test(ps));
  check('B2 BuildJson 不再写 expireTs 键', !/"expireTs"/.test(ps));

  const mw = codeOnly('Server/Zongmen/Services/MapWorldService.cs');
  check('B3 不再从 PlayerSectEntry 读 ExpireTs（e.ExpireTs 已消失）',
    !/\be\.ExpireTs\b/.test(mw));
}

console.log('\n== C. 协议层该留的必须留着（防误删） ==');
{
  const mm = codeOnly('Server/Zongmen/Domain/MapMessages.cs');
  const n = (mm.match(/\[ProtoMember\(12\)\]\s*public long ExpireTs/g) || []).length;
  check('C1 SettlementDto / PlaceEntity 的 ExpireTs (ProtoMember 12) 仍在，共 2 处',
    n === 2, `实际 ${n} 处`);

  const pb = read('web/js/pb.js');
  check('C2 前端仍解 ExpireTs 字段 12', /case 12:.*expireTs/.test(pb));
}

console.log('');
if (failures === 0) {
  console.log('全部通过。');
  process.exit(0);
} else {
  console.log(`${failures} 项失败。`);
  process.exit(1);
}
