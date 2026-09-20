import fs from "node:fs";
import path from "node:path";

const appRoot = process.argv[2] || "/app";
const target = path.join(appRoot, ".next/server/chunks/8635.js");
const marker = "9router-auto-router:v1";
function fail(message) { console.error(`9Router upstream compatibility check failed.\n${message}\nReview the latest upstream changes before rebuilding.`); process.exit(1); }
if (!fs.existsSync(target)) fail(`Expected integration anchor no longer exists:\n${target}`);
let source = fs.readFileSync(target, "utf8");
if (source.includes(marker)) { console.log("9router-auto-router patch already applied."); process.exit(0); }
const importAnchor = 'w=c(46945),x=a([e,j]);async function y';
if (source.split(importAnchor).length !== 2) fail(`Expected unique import anchor no longer exists:\n${target}\n${importAnchor}`);
source = source.replace(importAnchor, 'w=c(46945),aa=require("/opt/9router-auto-router/auto-router.cjs"),x=a([e,j]);/* 9router-auto-router:v1 */async function y');
const publicAnchor = 'if("fusion"===f)return t.info("CHAT",`Combo "${d}" with ${u.length} models (strategy: fusion)`),(0,o.vt)';
const publicPatch = 'if("auto"===f)return aa.routeAutoCombo({body:c,comboName:d,comboStrategies:e,globalStrategy:k.comboStrategy,log:t,delegate:(nextBody,target)=>z(nextBody,target,b,a,j)});';
const recursiveAnchor = 'if("fusion"===j)return t.info("CHAT",`Combo "${b}" with ${f.length} models (strategy: fusion)`),(0,o.vt)';
const recursivePatch = 'if("auto"===j)return aa.routeAutoCombo({body:a,comboName:b,comboStrategies:i,globalStrategy:g.comboStrategy,log:t,delegate:(a,b)=>z(a,b,c,d,e)});';
for (const [anchor, patch, name] of [[publicAnchor, publicPatch, "public combo dispatch"], [recursiveAnchor, recursivePatch, "recursive combo dispatch"]]) {
  if (source.split(anchor).length !== 2) fail(`Expected unique ${name} anchor no longer exists:\n${target}\n${anchor}`);
  source = source.replace(anchor, `${patch}${anchor}`);
}
if (!source.includes(marker) || source.includes(`${marker}${marker}`)) fail("Patch integrity validation failed.");
fs.writeFileSync(target, source);
console.log("Applied 9router-auto-router patch to .next/server/chunks/8635.js.");
