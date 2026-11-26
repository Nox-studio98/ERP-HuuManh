import json,sys,base64,time,urllib.request,re,concurrent.futures as cf
ACC=open('acc.txt').read().strip(); model=sys.argv[1]; tiles=json.loads(sys.argv[2]); extra=json.loads(sys.argv[3]) if len(sys.argv)>3 else {}
tag=sys.argv[4] if len(sys.argv)>4 else 'tiled'
prompt="""Ảnh là một phần bảng đặt hàng rau củ. Cột: TÊN NVL, ĐVT GỌI HÀNG, TỔNG SL, sau đó là vài cột chi nhánh (chỉ những cột nhìn thấy đầy đủ trong ảnh).
Đọc CHÍNH XÁC từng ô, đúng hàng đúng cột (ô nền xanh là có số, ô trắng là trống). Trả về DUY NHẤT JSON:
{"branches":["tên chi nhánh theo thứ tự cột"],"rows":[{"name":"...","unit":"...","total":số,"qty":[số hoặc null cho từng chi nhánh]}]}
"1,5" -> 1.5 ; "1." hoặc "1," -> 1 ; ô trống -> null."""
def call(img):
  b64=base64.b64encode(open(img,'rb').read()).decode()
  body={"messages":[{"role":"user","content":[{"type":"text","text":prompt},{"type":"image_url","image_url":{"url":"data:image/png;base64,"+b64}}]}],"max_tokens":4000,"temperature":0}; body.update(extra)
  for i in range(4):
    req=urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACC}/ai/run/{model}",data=json.dumps(body).encode(),headers={"Content-Type":"application/json","Authorization":"Bearer proxy-injected"})
    try: r=json.load(urllib.request.urlopen(req,timeout=280)); break
    except urllib.error.HTTPError as e: print(img,"HTTP",e.code,e.read()[:200]); time.sleep(10)
  else: raise SystemExit("fail")
  res=r["result"]; txt=res.get("response")
  if txt is None and "choices" in res: txt=res["choices"][0]["message"].get("content")
  if not isinstance(txt,str): txt=json.dumps(txt,ensure_ascii=False)
  txt=re.sub(r'(?s)<think>.*?</think>','',txt)
  return json.loads(re.search(r'\{.*\}',txt,re.S).group(0)), res.get("usage",{})
t=time.time()
with cf.ThreadPoolExecutor(4) as ex: outs=list(ex.map(call,tiles))
neur=sum(u.get('neurons',0) for _,u in outs)
merged={"branches":[],"rows":[]}; byname={}
for P,_ in outs:
  merged["branches"]+=P["branches"]; n=len(P["branches"])
  for r in P["rows"]:
    k=r["name"].strip().lower()
    if k not in byname: byname[k]={"name":r["name"],"unit":r.get("unit"),"total":r.get("total"),"qty":[]}; merged["rows"].append(byname[k])
  for k,row in byname.items():
    src=next((r for r in P["rows"] if r["name"].strip().lower()==k),None)
    q=(src.get("qty") if src else None) or []
    row["qty"]+= (q+[None]*n)[:n]
json.dump(merged,open(f'{tag}.raw.txt','w'),ensure_ascii=False)
print(f"{tag}: {time.time()-t:.1f}s, neurons {neur:.1f}")
