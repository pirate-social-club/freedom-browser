import asyncio,json,urllib.request,sys
import websockets
async def main():
 targets=json.load(urllib.request.urlopen('http://127.0.0.1:9244/json/list',timeout=3))
 target=next(t for t in targets if 'src/renderer/index.html' in t.get('url',''))
 expr="""(async()=>({hns:(await window.serviceRegistry.getRegistry()).hns,views:await Promise.all(Array.from(document.querySelectorAll('webview')).map(async v=>({url:v.getURL(),title:v.getTitle(),content:await v.executeJavaScript('({body:document.body.innerText,status:performance.getEntriesByType("navigation")[0]?.responseStatus})')})))}))()"""
 async with websockets.connect(target['webSocketDebuggerUrl']) as ws:
  await ws.send(json.dumps({'id':1,'method':'Runtime.evaluate','params':{'expression':expr,'awaitPromise':True,'returnByValue':True}}))
  while True:
   r=json.loads(await ws.recv())
   if r.get('id')==1:
    assert 'error' not in r,r
    assert 'exceptionDetails' not in r.get('result',{}),r
    value=r['result']['result'].get('value');print(json.dumps(value,indent=2))
    if len(sys.argv)>1:Path(sys.argv[1]).write_text(json.dumps(value,indent=2)+'\n')
    break
from pathlib import Path
asyncio.run(main())
