import json,sys,base64,urllib.request,re,time
from PIL import Image
from greenmask import mask,COLS
ACC=open('acc.txt').read().strip(); MODEL="@cf/google/gemma-4-26b-a4b-it"
T=json.load(open('truth.json')); br=T['cols'][3:]; N=len(br)
def num(x):
  if x in (None,""): return None
  try: return round(float(str(x).replace(',','.').rstrip('.') or 0),3)
  except: return None
P=json.load(open(sys.argv[1])); M=mask()
img=Image.open('anh-mau.png').convert('RGB')
neur=0
def read_cell(i,j):
  global neur
  y=int(round(78+10.4*i)); x0,x1=COLS[j]
  c=img.crop((x0-2,y-7,x1+2,y+7)); c=c.resize((c.width*6,c.height*6),Image.LANCZOS)
  import io; b=io.BytesIO(); c.save(b,'PNG')
  body={"messages":[{"role":"user","content":[{"type":"text","text":"Ảnh là MỘT ô bảng tính chứa một số (dấu phẩy là thập phân, '1.' nghĩa là 1). Chỉ trả về con số, ví dụ 0.5 hoặc 3. Ô trống thì trả về EMPTY."},{"type":"image_url","image_url":{"url":"data:image/png;base64,"+base64.b64encode(b.getvalue()).decode()}}]}],"max_tokens":20,"temperature":0,"reasoning_effort":"none","chat_template_kwargs":{"enable_thinking":False}}
  for k in range(4):
    try:
      r=json.load(urllib.request.urlopen(urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACC}/ai/run/{MODEL}",data=json.dumps(body).encode(),headers={"Content-Type":"application/json","Authorization":"Bearer proxy-injected"}),timeout=120)); break
    except urllib.error.HTTPError as e: time.sleep(8)
  res=r['result']; neur+=res.get('usage',{}).get('neurons',0)
  txt=res.get('response') or res['choices'][0]['message']['content']
  m=re.search(r'\d+(?:[.,]\d+)?',txt); return num(m.group(0)) if m else None
rows_by={r['name'].strip().lower():r for r in P['rows']}
ok=cells=0; okrows=review=fixed_calls=0; wrong_accepted=0
for i,tr in enumerate(T['rows']):
  r=rows_by.get(tr[0].lower()); q=[num(v) for v in ((r or {}).get('qty') or [])+[None]*N][:N]
  tot=num((r or {}).get('total')) if r else None
  unc=[]
  for j in range(N):
    has=q[j] is not None
    if M[i][j] and not has: unc.append(j)
    if M[i][j] and not has: q[j]=read_cell(i,j); fixed_calls+=1
    elif not M[i][j] and has: q[j]=None; fixed_calls+=0  # ô trắng: bỏ giá trị lệch cột
  if len(unc)==1 and tot is not None:
    v=round(tot-sum(q[k] or 0 for k in range(N) if k!=unc[0]),3)
    if v>0: q[unc[0]]=v
  truth=[num(v) for v in tr[3:]]
  good=tot is not None and abs(sum(v or 0 for v in q)-tot)<1e-6 and all((v is not None)==m for v,m in zip(q,M[i]))
  if good:
    okrows+=1
    if q!=truth: wrong_accepted+=1; print("CHẤP NHẬN SAI",tr[0],q,truth)
  else: review+=1; print("cần xem:",tr[0],q,"tổng",tot)
  ok+=sum(a==b for a,b in zip(q,truth)); cells+=N
print(f"ô đúng {ok}/{cells}; dòng tự duyệt {okrows}/22 (sai lọt: {wrong_accepted}); cần xem {review}; gọi đọc lại {fixed_calls} ô, thêm {neur:.1f} neuron")
