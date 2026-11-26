import json,sys,re
T=json.load(open('truth.json')); br=T['cols'][3:]
def num(x):
  if x in (None,""): return None
  try: return round(float(str(x).replace(',','.').rstrip('.') or 0),3)
  except: return "?"
txt=open(sys.argv[1]).read()
txt=re.sub(r'(?s)<think>.*?</think>','',txt)
m=re.search(r'\{.*\}',txt,re.S)
try: P=json.loads(m.group(0))
except Exception as e: print("JSON lỗi",e); sys.exit()
pr={r['name'].strip().lower():r for r in P['rows']}
cells=ok=0; rowsum_ok=0; errs=[]
for r in T['rows']:
  name=r[0]; p=pr.get(name.lower())
  if not p: errs.append(f"thiếu dòng {name}"); cells+=len(br)+1; continue
  tq=[num(v) for v in r[3:]]; pq=[num(v) for v in (p.get('qty') or [])]+[None]*20
  for i,b in enumerate(br):
    cells+=1
    if tq[i]==pq[i]: ok+=1
    else: errs.append(f"{name} @ {b}: đúng {tq[i]} đọc {pq[i]}")
  cells+=1
  if num(r[2])==num(p.get('total')): ok+=1
  else: errs.append(f"{name} TỔNG: đúng {r[2]} đọc {p.get('total')}")
  s=round(sum(v for v in pq[:len(br)] if isinstance(v,float)),3)
  if abs(s-(num(p.get('total')) or 0))<1e-6: rowsum_ok+=1
print(f"chi nhánh đọc: {P.get('branches')}")
print(f"ô đúng {ok}/{cells} ({100*ok/cells:.1f}%), dòng tự khớp TỔNG {rowsum_ok}/{len(T['rows'])}")
for e in errs[:40]: print(" -",e)
