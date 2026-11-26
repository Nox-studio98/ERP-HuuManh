import json,sys
from PIL import Image
import numpy as np
im=np.asarray(Image.open('anh-mau.png').convert('RGB')).astype(int)
COLS=[(275,322),(322,366),(366,412),(412,455),(455,500),(500,544),(544,590),(590,633),(633,678),(678,720),(720,762),(762,807)]
def mask(n=22,y0=78,h=10.4):
  M=[]
  for i in range(n):
    y=int(round(y0+h*i)); row=[]
    for x0,x1 in COLS:
      p=im[y-2:y+3,x0+4:x1-4].reshape(-1,3); r,g,b=p[:,0],p[:,1],p[:,2]
      row.append(bool(((g-r>12)&(g-b>8)).mean()>0.3))
    M.append(row)
  return M
if __name__=="__main__":
  T=json.load(open('truth.json')); M=mask(); bad=0
  for tr,m in zip(T['rows'],M):
    t=[v not in ("",None) for v in tr[3:]]
    if t!=m: bad+=1; print(tr[0],[ (i,a,b) for i,(a,b) in enumerate(zip(t,m)) if a!=b])
  print("dòng lệch:",bad)
