import socket,threading
# This stub exists only inside the disposable namespace.
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('127.0.0.53',53))
def forward(wire,addr):
 q=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);q.settimeout(3)
 try:q.sendto(wire,('10.0.2.3',53));reply,_=q.recvfrom(65535);s.sendto(reply,addr)
 except OSError:pass
 finally:q.close()
while True:
 wire,addr=s.recvfrom(65535);threading.Thread(target=forward,args=(wire,addr),daemon=True).start()
