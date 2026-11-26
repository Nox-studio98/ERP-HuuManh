"""Quy trình đầy đủ: chuẩn hoá ảnh -> cắt 4 dải -> Gemma 4 -> màu ô -> bù bằng cột TỔNG -> chấm điểm."""
import json,sys,base64,io,re,time,urllib.request,concurrent.futures as cf
from PIL import Image
import numpy as np
ACC=open('acc.txt').read().strip(); MODEL="@cf/google/gemma-4-26b-a4b-it"
T=json.load(open('truth.json')); BR=T['cols'][3:]; N=len(BR)
COLS=[(275,322),(322,366),(366,412),(412,455),(455,500),(500,544),(544,590),(590,633),(633,678),(678,720),(720,762),(762,807)]
CUTS=[(275,412),(412,544),(544,678),(678,810)]; LEFT=275; W0=817
PROMPT="""Ảnh là một phần bảng đặt hàng rau củ. Cột: TÊN NVL, ĐVT GỌI HÀNG, TỔNG SL, sau đó là vài cột chi nhánh (chỉ những cột nhìn thấy đầy đủ trong ảnh).
Đọc CHÍNH XÁC từng ô, đúng hàng đúng cột (ô nền xanh là có số, ô trắng là trống). Trả về DUY NHẤT JSON:
{"branches":["tên chi nhánh theo thứ tự cột"],"rows":[{"name":"...","unit":"...","total":số,"qty":[số hoặc null cho từng chi nhánh]}]}
"1,5" -> 1.5 ; "1." hoặc "1," -> 1 ; ô trống -> null."""
def num(x):
  if x in (None,""): return None
  try: return round(float(str(x).replace(',','.').rstrip('.') or 0),3)
  except: return None
def ai(b64):
  body={"messages":[{"role":"user","content":[{"type":"text","text":PROMPT},{"type":"image_url","image_url":{"url":"data:image/png;base64,"+b64}}]}],"max_tokens":4000,"temperature":0,"reasoning_effort":"none","chat_template_kwargs":{"enable_thinking":False}}
  for k in range(5):
    try:
      r=json.load(urllib.request.urlopen(urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACC}/ai/run/{MODEL}",data=json.dumps(body).encode(),headers={"Content-Type":"application/json","Authorization":"Bearer proxy-injected"}),timeout=200)); break
    except Exception as e: time.sleep(10)
  else: raise RuntimeError("AI lỗi")
  res=r['result']; txt=res.get('response') or res['choices'][0]['message']['content']
  return json.loads(re.search(r'\{.*\}',txt,re.S).group(0)), res.get('usage',{}).get('neurons',0)
def run(path):
  im=Image.open(path).convert('RGB')
  if im.width!=W0: im=im.resize((W0,round(im.height*W0/im.width)),Image.LANCZOS)   # chuẩn hoá về khổ mẫu
  a=np.asarray(im).astype(int)
  tiles=[]
  for x0,x1 in CUTS:
    t=Image.new('RGB',(LEFT+x1-x0,im.height),'white'); t.paste(im.crop((0,0,LEFT,im.height)),(0,0)); t.paste(im.crop((x0,0,x1,im.height)),(LEFT,0))
    t=t.resize((t.width*3,t.height*3),Image.LANCZOS); b=io.BytesIO(); t.save(b,'PNG'); tiles.append(base64.b64encode(b.getvalue()).decode())
  with cf.ThreadPoolExecutor(4) as ex: outs=list(ex.map(ai,tiles))
  neur=sum(n for _,n in outs)
  # mặt nạ ô xanh
  M=[]
  for i in range(22):
    y=int(round(78+10.4*i)); row=[]
    for x0,x1 in COLS:
      p=a[y-2:y+3,x0+4:x1-4].reshape(-1,3); row.append(bool(((p[:,1]-p[:,0]>12)&(p[:,1]-p[:,2]>8)).mean()>0.3))
    M.append(row)
  ok=cells=auto=review=wrong=0; raw_ok=0
  for i,tr in enumerate(T['rows']):
    q=[]; tot=None
    for k,(P,_) in enumerate(outs):
      r=next((r for r in P['rows'] if r['name'].strip().lower()==tr[0].lower()),None)
      if r is None and i<len(P['rows']): r=P['rows'][i]   # tên đọc lệch: lấy theo thứ tự dòng
      qq=[num(v) for v in ((r or {}).get('qty') or [])]+[None]*3; q+=qq[:3]
      if r and tot is None: tot=num(r.get('total'))
    truth=[num(v) for v in tr[3:]]; raw_ok+=sum(x==y for x,y in zip(q,truth))
    unc=[]
    for j in range(N):
      if M[i][j] and q[j] is None: unc.append(j)
      elif not M[i][j] and q[j] is not None: q[j]=None
    if len(unc)==1 and tot is not None:
      v=round(tot-sum(q[k] or 0 for k in range(N) if k!=unc[0]),3)
      if v>0: q[unc[0]]=v; unc=[]
    good=not unc and tot is not None and abs(sum(v or 0 for v in q)-tot)<1e-6
    if good:
      auto+=1
      if q!=truth: wrong+=1
    else: review+=1
    ok+=sum(x==y for x,y in zip(q,truth)); cells+=N
  return dict(raw=round(100*raw_ok/cells,1),final=round(100*ok/cells,1),auto=auto,review=review,wrong_accepted=wrong,neurons=round(neur))
if __name__=="__main__":
  for p in sys.argv[1:]:
    t=time.time(); r=run(p); r['sec']=round(time.time()-t); print(p.split('/')[-1],json.dumps(r))
