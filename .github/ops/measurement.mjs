import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,webkit,expect} from '@playwright/test';
import {publicationGraph} from '../../apps/cli/src/publication/publication-graph.ts';
import {publicHttp} from '../../apps/cli/src/publication/publication-http.ts';
const output='../../.generated/activation-browser';
await mkdir(output,{recursive:true});
const viewer='https://apaapapapapa.github.io/FantasySimulation/';
const reader='https://fantasysimulation-replay-reader.tokyojp.workers.dev/';
const sourceSha='4618f3cc78942b354e1b8271f845f288cd4582c6';
const report={sourceSha,expectedViewerSha:process.env.EXPECTED_VIEWER_SHA,phase:process.env.ACCEPTANCE_PHASE,publicationRun:36057392026,startedAt:new Date().toISOString(),status:'incomplete',browsers:[]};
try {
  const build=JSON.parse((await publicHttp(viewer)('build.json',4096)).toString('utf8'));
  assert.equal(build.sourceSha,process.env.EXPECTED_VIEWER_SHA); report.viewer = build;
  const get=publicHttp(reader);
  const bytesByKey=new Map();
  let graphRequests=0;
  const graph=await publicationGraph(async (key,limit)=>{
    graphRequests++;
    const bytes=await get(key,limit);
    bytesByKey.set(key,bytes);
    return bytes;
  });
  assert.deepEqual([...graph.sources],[sourceSha]);
  assert.equal(graph.catalog.sets.length,1);
  const set=[...graph.sets.values()][0];
  assert.equal(set.totalRows,2);assert.equal(set.incompleteRows,0);
  assert.equal(graph.objects.size,2);
  const expectedIds=new Map();
    const finalSteps=new Map();
  for(const ref of graph.catalog.sets) {
    for(const pageRef of graph.sets.get(ref.setHash).pages) {
      const key='sets/'+ref.setHash.slice(7)+'/'+pageRef.pageHash.slice(7)+'.json';
      const page=JSON.parse(bytesByKey.get(key).toString('utf8'));
      for(const row of page.rows) {
        assert.ok(row.replay);
        const manifestKey='objects/'+row.replay.objectHash.slice(7)+'/manifest.json';
        const manifest=JSON.parse(bytesByKey.get(manifestKey).toString('utf8'));
        expectedIds.set(row.slotId.slice(7),manifest.id);
          finalSteps.set(manifest.id,manifest.lastVerifiedStep);
      }
    }
  }
  assert.equal(expectedIds.size,2);
  report.graph={catalogHash:graph.current.catalogHash,files:graph.files.size,bytes:graph.totalBytes,sets:graph.sets.size,matches:set.totalRows,incomplete:set.incompleteRows,requests:graphRequests};
  console.log('PRODUCTION_GRAPH='+JSON.stringify(report.graph));
  for (const [name,engine] of [['chromium',chromium],['webkit',webkit]]) {
    const record={name,viewport:{width:390,height:844},status:'incomplete',matches:[],readerRequests:0,apiRequests:0,pageErrors:[],httpErrors:[]};
    report.browsers.push(record);
    const browser=await engine.launch({headless:true,...(name==='chromium'?{args:['--use-gl=angle','--use-angle=swiftshader','--enable-webgl','--enable-unsafe-swiftshader']}: {})});
    const context=await browser.newContext({viewport:record.viewport,hasTouch:true});
    const page=await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('request',request=>{
      if(request.url().startsWith(reader))record.readerRequests++;
      if(new URL(request.url()).pathname.startsWith('/api/'))record.apiRequests++;
    });
    page.on('pageerror',error=>record.pageErrors.push(error.message));
    page.on('response',response=>{
      if(response.status()>=400 && (response.url().startsWith(reader)||response.url().startsWith(viewer)))
        record.httpErrors.push({url:response.url(),status:response.status()});
    });
    try {
      await page.goto(viewer,{waitUntil:'domcontentloaded'});
      await expect(page.getByRole('heading',{name:'保存リプレイ一覧',exact:true})).toBeVisible();
      await expect(page.getByRole('table',{name:'公開試合一覧'}).getByRole('row')).toHaveCount(3,{timeout:20000});
      await expect(page.getByRole('region',{name:'試合の選択'})).toContainText('全2件');
      const links=page.getByRole('link',{name:/^リプレイを開く /});
      await expect(links).toHaveCount(2);
      record.listRequests=record.readerRequests;
      await page.screenshot({path:output+'/'+name+'-list.png',fullPage:true});
      for(let i=0;i<2;i++) {
        const before=record.readerRequests;
        const link=links.nth(i);
        const expectedUrl=new URL(await link.getAttribute('href'),viewer).href;
        const replayId=expectedIds.get(new URL(expectedUrl).hash.split('/').at(-1));
        assert.ok(replayId && replayId.length>0,'Selected link must bind a verified manifest');
        await link.click();
        await expect(page).toHaveURL(expectedUrl);
        await expect(page.getByLabel('リプレイID',{exact:true})).toHaveText(replayId,{timeout:20000});
        await expect(page.getByLabel('現在のstep')).toHaveText('0');
        const canvas=page.getByRole('img',{name:'保存ログの3D表示'});
        await expect(canvas).toHaveAttribute('data-rendered','true',{timeout:20000});
        await page.getByLabel('再生速度').selectOption('4');
        await page.getByRole('button',{name:'再生',exact:true}).click();
        await expect(page.getByLabel('現在のstep')).toHaveText(String(finalSteps.get(replayId)),{timeout:45000});
        const pause=page.getByRole('button',{name:'一時停止',exact:true});
        if(await pause.isVisible())await pause.click();
        await page.getByLabel('表示stepを入力').fill('1');
        await expect(page.getByLabel('現在のstep')).toHaveText('1');
        await page.getByRole('combobox',{name:'カメラ',exact:true}).selectOption('side');
        await expect(canvas).toHaveAttribute('data-rendered','true');
        await page.screenshot({path:output+'/'+name+'-match-'+i+'.png',fullPage:true});
        const url=page.url();
        assert.equal(url,expectedUrl);
        assert.match(url,/#\/sets\/[a-f0-9]{64}\/pages\/0\/matches\/[a-f0-9]{64}$/);
        const playbackRequests=record.readerRequests-before;
        const beforeReload=record.readerRequests;
        await page.reload({waitUntil:'domcontentloaded'});
        await expect(page.getByLabel('リプレイID',{exact:true})).toHaveText(replayId,{timeout:20000});
        await expect(page.getByLabel('現在のstep')).toHaveText('0');
        await expect(canvas).toHaveAttribute('data-rendered','true',{timeout:20000});
        await expect(page.getByRole('alert')).toHaveCount(0);
        record.matches.push({replayId,lastStep:finalSteps.get(replayId),fullPlayback:true,url,playbackRequests,reloadRequests:record.readerRequests-beforeReload,status:'pass'});
      }
      assert.equal(record.apiRequests,0);
      assert.deepEqual(record.pageErrors,[]);
      assert.deepEqual(record.httpErrors,[]);
      assert.ok(record.readerRequests<300,'Bound production acceptance reads');
      record.status='pass';
      console.log('PRODUCTION_BROWSER='+JSON.stringify(record));
    } catch(error) {
      record.status='fail';record.error=String(error);
      await page.screenshot({path:output+'/'+name+'-failure.png',fullPage:true}).catch(()=>{});
    } finally {await context.close();await browser.close();}
  }
  assert.ok(report.browsers.length===2 && report.browsers.every(b=>b.status==='pass' && b.matches.length===2),'Every browser and both selected replays must pass');
  const after=JSON.parse((await get('catalog/current.json',4096)).toString('utf8'));
  assert.deepEqual(after,graph.current,'Published generation changed during acceptance');
  report.status='pass';
} catch(error) {report.status='fail';report.error=String(error);throw error;}
finally {
  report.finishedAt=new Date().toISOString();
  await writeFile(output+'/report.json',JSON.stringify(report,null,2));
  console.log('PRODUCTION_ACCEPTANCE='+JSON.stringify(report));
}
