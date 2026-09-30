import asyncio,json,time,subprocess,urllib.request
from pathlib import Path
import websockets
p=Path(__file__).parent;deadline=json.loads((p/'timing.json').read_text())['deadline_epoch']-45
async def cdp(method,params):
 targets=json.load(urllib.request.urlopen('http://127.0.0.1:9244/json/list',timeout=2))
 target=next(t for t in targets if 'src/renderer/index.html' in t.get('url',''))
 async with websockets.connect(target['webSocketDebuggerUrl'],open_timeout=3) as ws:
  await ws.send(json.dumps({'id':1,'method':method,'params':params}))
  while True:
   result=json.loads(await asyncio.wait_for(ws.recv(),timeout=8))
   if result.get('id')==1:
    assert 'error' not in result,result
    assert 'exceptionDetails' not in result.get('result',{}),result
    return result['result']
def evaluate(expression):return asyncio.run(cdp('Runtime.evaluate',{'expression':expression,'awaitPromise':True,'returnByValue':True}))['result'].get('value')
SNAPSHOT="""(async()=>{const tabs=await import('./lib/tabs.js');return {epoch:Date.now()/1000,expected:new URL('pages/home.html',location.href).href,settings:(await window.electronAPI.getSettings()),hns:(await window.serviceRegistry.getRegistry()).hns,rendererHns:window.__rendererState?.registry?.hns,views:tabs.getTabs().map(t=>({id:t.id,src:t.webview.getAttribute('src'),url:(()=>{try{return t.webview.getURL()}catch{return null}})(),tabUrl:t.url,current:t.navigationState.currentPageUrl,pending:t.navigationState.pendingNavigationUrl}))};})()"""
def snapshot():return evaluate(SNAPSHOT)
def local(record):
 assert record['settings']['autoUpdate'] is False,'automatic updates not disabled'
 assert len(record['views'])==1,'unexpected startup tab count'
 view=record['views'][0]
 assert all(view[key]==record['expected'] for key in ['src','url','tabUrl','current']),record
 return view
end=min(time.time()+40,deadline);initial=None
while time.time()<end:
 try:
  initial=snapshot();local(initial);break
 except Exception:time.sleep(.2)
else:raise RuntimeError('real initial local tab not observable')
(p/'fresh-first-tab.json').write_text(json.dumps(initial,indent=2)+'\n')
assert initial['hns'].get('localResolverReady') is not True,'initial readiness transition already missed; no inferred cold result'
# Observe real IPC registry events without modifying readiness or navigating.
evaluate("""window.__welcomeRegistryEvidence=[];window.serviceRegistry.onUpdate(r=>{const v=document.querySelector('webview');window.__welcomeRegistryEvidence.push({epoch:Date.now()/1000,hns:r.hns,src:v?.getAttribute('src'),url:v?.getURL?.()});});true""")
end=min(time.time()+150,deadline);ready=None
while time.time()<end:
 record=snapshot();local(record)
 events=evaluate('window.__welcomeRegistryEvidence')
 if record['hns'].get('localResolverReady') is True and any(e['hns'].get('localResolverReady') is True for e in events):
  ready={'first':initial,'ready':record,'real_registry_events':events};break
 time.sleep(.5)
assert ready,'no actual false-to-true registry transition observed'
assert all(e['src']==initial['expected'] and e['url']==initial['expected'] for e in ready['real_registry_events']),'registry event navigated the first tab'
(p/'fresh-registry-transition.json').write_text(json.dumps(ready,indent=2)+'\n')
# Instrument the next renderer document before a real reload, with helpers left running.
observer="""window.__welcomeCreationEvidence=[];window.__welcomeMutationObserver=new MutationObserver(()=>{for(const v of document.querySelectorAll('webview')){if(v.__welcomeObserved)continue;v.__welcomeObserved=true;window.__welcomeCreationEvidence.push({epoch:Date.now()/1000,src:v.getAttribute('src'),hns:window.__rendererState?.registry?.hns});}});window.__welcomeMutationObserver.observe(document,{childList:true,subtree:true});"""
async def warm_reload():
 targets=json.load(urllib.request.urlopen('http://127.0.0.1:9244/json/list',timeout=2))
 target=next(t for t in targets if 'src/renderer/index.html' in t.get('url',''))
 async with websockets.connect(target['webSocketDebuggerUrl'],open_timeout=3) as ws:
  request_id=0;injection=None
  async def rpc(method,params):
   nonlocal request_id
   request_id+=1;wanted=request_id
   await ws.send(json.dumps({'id':wanted,'method':method,'params':params}))
   while True:
    reply=json.loads(await asyncio.wait_for(ws.recv(),timeout=8))
    if reply.get('id')!=wanted:continue
    assert 'error' not in reply,reply
    assert 'exceptionDetails' not in reply.get('result',{}),reply
    return reply['result']
  try:
   await rpc('Page.enable',{})
   injection=(await rpc('Page.addScriptToEvaluateOnNewDocument',{'source':observer}))['identifier']
   await rpc('Page.reload',{'ignoreCache':True})
   end=min(time.time()+35,deadline);observations=[]
   while time.time()<end:
    record=None;creation=None;read_error=None
    try:
     record=(await rpc('Runtime.evaluate',{'expression':SNAPSHOT,'awaitPromise':True,'returnByValue':True}))['result'].get('value')
     creation=(await rpc('Runtime.evaluate',{'expression':'window.__welcomeCreationEvidence','returnByValue':True}))['result'].get('value')
    except Exception as error:read_error=str(error)
    # Persist every diagnostic before evaluating readiness or navigation assertions.
    observations.append({'epoch':time.time(),'snapshot':record,'creation':creation,'read_error':read_error})
    (p/'warm-renderer-observations.json').write_text(json.dumps(observations,indent=2)+'\n')
    if record is not None:
     assert record['settings']['autoUpdate'] is False,'automatic updates not disabled'
     assert len(record['views'])<=1,'unexpected extra startup tab'
     if creation:
      assert len(creation)==1,'unexpected extra webview creation'
      assert creation[0]['src']==record['expected'],'unexpected first-creation src'
      assert creation[0].get('hns',{}).get('localResolverReady') is True,'warm readiness absent at actual first creation'
     if record['views']:
      view=record['views'][0]
      assert view['src']==record['expected'],'unexpected startup src'
      for key in ['url','tabUrl','current']:
       assert view.get(key) in [None,'','about:blank',record['expected']],'unexpected startup destination '+key
      if creation and all(view.get(key)==record['expected'] for key in ['src','url','tabUrl','current']):
       local(record)
       return {'kind':'warm renderer reload with existing live helpers; not full app restart','persistent_Page_session':True,'creation':creation,'observed':record,'observation_count':len(observations)}
    await asyncio.sleep(.2)
   raise RuntimeError('warm renderer first tab not observed')
  finally:
   if injection is not None:await rpc('Page.removeScriptToEvaluateOnNewDocument',{'identifier':injection})
   await rpc('Runtime.evaluate',{'expression':'window.__welcomeMutationObserver?.disconnect();true','returnByValue':True})
   await rpc('Page.disable',{})
warm=asyncio.run(warm_reload())
(p/'warm-renderer-first-tab.json').write_text(json.dumps(warm,indent=2)+'\n')
# Explicit address-bar actions remain manual; no availability claim for these sites.
manual=[]
for url in ['https://pirate.sc/','https://app.pirate/']:
 started=time.time();subprocess.run(['agent-browser','--session','freedom-hosted-package-acceptance','--cdp','9244','fill','input[placeholder="Enter hash, ID or URL"]',url],check=True,timeout=15)
 subprocess.run(['python3',str(p/'native-enter.py')],check=True,timeout=5)
 end=min(time.time()+8,deadline);observed=None
 while time.time()<end:
  record=snapshot();v=record['views'][0]
  if url in [v['url'],v['tabUrl'],v['current'],v['pending']] or (url.rstrip('/') in v['url'] and 'error.html' in v['url']):observed=record;break
  time.sleep(.2)
 assert observed,'explicit manual address was not routed'
 evaluate("document.getElementById('home-btn').click();true")
 end=min(time.time()+12,deadline);home=None
 while time.time()<end:
  try:home=snapshot();local(home);break
  except Exception:time.sleep(.2)
 else:raise RuntimeError('Home did not return to local welcome')
 manual.append({'intent_epoch':started,'explicit_input':url,'navigation_observed':observed,'Home_observed':home})
(p/'manual-navigation-home.json').write_text(json.dumps(manual,indent=2)+'\n')
(p/'welcome-summary.json').write_text(json.dumps({'passed':True,'default_first_tab_local':True,'real_registry_transition_stable':True,'warm_renderer_ready_before_first_tab':True,'full_app_restart_tested':False,'manual_remote_navigation_preserved':True,'Home_local':True},indent=2)+'\n')
print('Actual initial welcome, real registry transition, warm renderer startup and manual/Home controls passed',flush=True)
