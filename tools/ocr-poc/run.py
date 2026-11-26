import json,sys,base64,time,urllib.request,re
ACC=sys.argv[1]; model=sys.argv[2]; img=sys.argv[3]; extra=json.loads(sys.argv[4]) if len(sys.argv)>4 else {}
b64=base64.b64encode(open(img,'rb').read()).decode()
prompt="""Ảnh là bảng đặt hàng rau củ của một chuỗi nhà hàng. Hàng = mặt hàng; cột: TÊN NVL, ĐVT GỌI HÀNG, TỔNG SL, rồi mỗi cột là một chi nhánh.
Đọc CHÍNH XÁC từng ô. Trả về DUY NHẤT JSON, không giải thích:
{"branches":["tên chi nhánh theo thứ tự cột"],"rows":[{"name":"...","unit":"...","total":số,"qty":[số hoặc null cho mỗi chi nhánh, đúng thứ tự branches]}]}
Ô trống = null. Dấu phẩy hay chấm thập phân đều đổi về số thập phân (vd "1,5" -> 1.5, "1." -> 1)."""
body={"messages":[{"role":"user","content":[{"type":"text","text":prompt},{"type":"image_url","image_url":{"url":"data:image/png;base64,"+b64}}]}],"max_tokens":6000,"temperature":0}
body.update(extra)
req=urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACC}/ai/run/{model}",data=json.dumps(body).encode(),headers={"Content-Type":"application/json","Authorization":"Bearer proxy-injected"})
t=time.time()
try: r=json.load(urllib.request.urlopen(req,timeout=300))
except urllib.error.HTTPError as e: print("HTTP",e.code,e.read()[:500].decode()); sys.exit(1)
dt=time.time()-t
res=r.get("result",{})
txt=res.get("response")
if txt is None and "choices" in res: txt=res["choices"][0]["message"].get("content")
if not isinstance(txt,str): txt=json.dumps(txt,ensure_ascii=False)
usage=res.get("usage")
json.dump(r,open(model.split("/")[-1]+".full.json","w"),ensure_ascii=False)
out=model.split('/')[-1]
open(out+'.raw.txt','w').write(txt)
print("time %.1fs usage %s"%(dt,usage))
