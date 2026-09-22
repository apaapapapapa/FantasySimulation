import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, expect, it } from 'vite-plus/test';
import { architecture } from './architecture.ts';
import { withSources, importEdges } from './ast.ts';
import { determinism, firstPartyJavaScript } from './determinism.ts';
const dirs:string[]=[];
function fixture(files:Record<string,string>) {
  const root=mkdtempSync(join(tmpdir(),'fantasy-quality-'));dirs.push(root);
  const all={'tsconfig.json':JSON.stringify({compilerOptions:{module:'ESNext',target:'ESNext',moduleResolution:'Bundler',noEmit:true},include:['apps/**/*.ts','apps/**/*.tsx','packages/**/*.ts']}),...files};
  for(const [path,content] of Object.entries(all)){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),content);}
  return {root,paths:Object.keys(all)};
}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it('native TS7 parsing includes type imports, mixed imports, reexports and import types',()=>{
  const path='packages/domain/src/a.ts';const f=fixture({[path]:"import type X from './x.ts'; import {type A, B} from './b.ts'; export type {C} from './c.ts'; type Y=import('./y.ts').Y; export {};"});
  expect(withSources(f.root,[path],files=>importEdges(files.get(path)!))).toEqual([{specifier:'./x.ts',typeOnly:true},{specifier:'./b.ts',typeOnly:false},{specifier:'./c.ts',typeOnly:true},{specifier:'./y.ts',typeOnly:true}]);
});
it('dependency-cruiser distinguishes runtime cycles from type-only reverse references',async()=>{
  for(const typeOnly of [true,false]) {
    const f=fixture({'packages/engine/src/a.ts':"import {b} from './b.ts';export const a=b;",'packages/engine/src/b.ts':`import ${typeOnly?'type':''} {a} from './a.ts';export const b=1;`});
    const result=await architecture(f.root,f.paths);
    expect(result.runtimeGraph.summary.violations.some(v=>v.rule.name==='no-runtime-cycle')).toBe(!typeOnly);
  }
});
it('detects aliases, type-only boundary leaks and unresolved source',async()=>{
  const f=fixture({'packages/domain/package.json':JSON.stringify({name:'@fantasy/domain',exports:{'.':'./src/a.ts'}}),'packages/domain/src/a.ts':"import type {S} from '../../../apps/api/src/store.ts';export type A=S;",'apps/api/src/store.ts':'export interface S {id:string}','apps/web/src/a.ts':"import {x} from './missing.ts';import type {A} from '@fantasy/domain';export {};"});
  const result=await architecture(f.root,f.paths);
  expect(result.publicGraph.summary.violations.map(v=>v.rule.name)).toContain('domain-is-independent');
  expect(result.publicGraph.summary.violations.map(v=>v.rule.name)).toContain('unresolved');
  const web=result.publicGraph.modules.find(m=>m.source==='apps/web/src/a.ts')!;
  expect(web.dependencies.some(d=>d.resolved==='packages/domain/src/a.ts'&&!d.couldNotResolve)).toBe(true);
});
it('rejects unsupported module expressions and syntax rather than omitting their edges',()=>{
  const path='packages/engine/src/a.ts';
  for(const code of ['import(name);','export const = ;']) {
    const f=fixture({[path]:code});expect(()=>withSources(f.root,[path],files=>importEdges(files.get(path)!))).toThrow(Error);
  }
});
it('finds implicit clocks, global access, random aliases and crypto entropy via AST',()=>{
  const path='packages/engine/src/a.ts';
  for(const code of ['Date.now();','new Date();','fetch("/");','const g=globalThis;','Math.random();','Math["random"]();','const m=Math;','const {random}=Math;','import {randomBytes} from "node:crypto";']) {
    const f=fixture({[path]:code});expect(withSources(f.root,[path],files=>determinism(path,files.get(path)!)).length,code).toBeGreaterThan(0);
  }
  const f=fixture({[path]:'import {createHash as hash} from "node:crypto"; const x=Math.floor(1.5); // Math.random()\n const text="Date.now()";'});
  expect(withSources(f.root,[path],files=>determinism(path,files.get(path)!))).toEqual([]);
});
it('rejects tracked JS source, not legitimate .js import specifiers in TS',()=>{
  expect(firstPartyJavaScript(['apps/a.ts','scripts/a.mjs','apps/b.js','data/c.jsx','.generated/file.js','dist/b.js','node_modules/b.js'])).toEqual(['scripts/a.mjs','apps/b.js','data/c.jsx']);
});
it('resolves TypeScript paths using the library resolver and still detects boundary violations',async()=>{
  const f=fixture({'tsconfig.json':JSON.stringify({compilerOptions:{target:'ESNext',module:'ESNext',moduleResolution:'Bundler',paths:{'@server/*':['./apps/api/src/*']}},include:['apps/**/*.ts','packages/**/*.ts']}),'apps/api/src/store.ts':'export interface S {id:string}','packages/domain/src/a.ts':"import type {S} from '@server/store'; export type A=S;"});
  const result=await architecture(f.root,f.paths);
  expect(result.publicGraph.summary.violations.map(v=>v.rule.name)).toContain('domain-is-independent');
  expect(result.publicGraph.summary.violations.map(v=>v.rule.name)).not.toContain('unresolved');
});
