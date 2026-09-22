import { execFileSync } from 'node:child_process';
import { architecture } from './quality/architecture.ts';
import { withSources } from './quality/ast.ts';
import { determinism, firstPartyJavaScript } from './quality/determinism.ts';
// Development-only guard. Final source acceptance remains the existing source harness.
try {
  if(process.argv.length!==2)throw Error('Usage: node scripts/quality.ts');
  const paths=execFileSync('git',['ls-files','-z'],{encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024}).split('\0').filter(Boolean);
  const root=process.cwd();
  const js=firstPartyJavaScript(paths);
  const graph=await architecture(root,paths);
  const enginePaths=paths.filter(path=>/^packages\/engine\/src\/.*\.tsx?$/.test(path)&&! /\.(?:test|d)\.tsx?$/.test(path));
  const findings=withSources(root,enginePaths,sources=>[...sources].flatMap(([path,file])=>determinism(path,file)));
  const violations=[...graph.publicGraph.summary.violations,...graph.runtimeGraph.summary.violations];
  for(const path of js)console.error(`${path}: first-party-javascript: use strict TypeScript, not a new JS source/config file.`);
  for(const finding of findings)console.error(`${finding.path}:${finding.line}: ${finding.rule}: ${finding.reason}`);
  for(const violation of violations)console.error(`Architecture: ${JSON.stringify(violation)}`);
  const result={producer:'quality-v1',javascriptViolations:js.length,determinismViolations:findings.length,architectureViolations:violations.length,sourceFiles:enginePaths.length,publicModules:graph.publicGraph.modules.length,runtimeModules:graph.runtimeGraph.modules.length};
  console.log(`FANTASY_QUALITY_RESULT=${JSON.stringify(result)}`);
  process.exitCode=js.length||findings.length||violations.length?1:0;
} catch(error) {
  console.error(error instanceof Error?error.message:'Quality evidence incomplete');
  process.exitCode=2;
}
