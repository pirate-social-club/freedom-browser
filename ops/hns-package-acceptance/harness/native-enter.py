import asyncio,json,urllib.request
import websockets
async def main():
 targets=json.load(urllib.request.urlopen('http://127.0.0.1:9244/json/list'))
 target=next(t for t in targets if 'src/renderer/index.html' in t.get('url',''))
 async with websockets.connect(target['webSocketDebuggerUrl']) as ws:
  for i,p in enumerate([{'type':'keyDown','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13,'text':'\r','unmodifiedText':'\r'},{'type':'keyUp','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13}],1):
   await ws.send(json.dumps({'id':i,'method':'Input.dispatchKeyEvent','params':p}))
   while True:
    r=json.loads(await ws.recv())
    if r.get('id')==i:
     assert 'error' not in r,r
     break
 print('Native Enter dispatched to address bar; no URL assignment')
asyncio.run(main())
