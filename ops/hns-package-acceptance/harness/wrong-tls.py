import socket,ssl,json,time,threading
from pathlib import Path
p=Path(__file__).parent;ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(str(p/'wrong-certificate.pem'),str(p/'private-test-material/wrong-key.pem'))
def serve(client):
 try:
  with ctx.wrap_socket(client,server_side=True) as tls:
   tls.settimeout(3);data=tls.recv(8192)
   with (p/'wrong-tls-events.jsonl').open('a') as f:f.write(json.dumps({'time':time.time(),'http_request_received':bool(data)})+'\n')
   if data:tls.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 32\r\nConnection: close\r\n\r\nWRONG DANE MUST NEVER BE VISIBLE!')
 except (OSError,ssl.SSLError):
  with (p/'wrong-tls-events.jsonl').open('a') as f:f.write(json.dumps({'time':time.time(),'connection_rejected':True})+'\n')
 finally:client.close()
s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',8443));s.listen(16)
while True:
 client,_=s.accept();threading.Thread(target=serve,args=(client,),daemon=True).start()
