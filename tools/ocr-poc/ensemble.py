import json,sys,itertools
T=json.load(open('truth.json')); br=T['cols'][3:]; N=len(br)
def num(x):
  if x in (None,""): return None
  try: return round(float(str(x).replace(',','.').rstrip('.') or 0),3)
  except: return None
runs=[json.load(open(f)) for f in sys.argv[1:]]
def get(P,name):
  for r in P['rows']:
    if r['name'].strip().lower()==name.lower(): return r
cells=ok=auto=review=0; bad_auto=0
for tr in T['rows']:
  name=tr[0]; total=num(tr[2]); truth=[num(v) for v in tr[3:]]
  cands=[]
  for P in runs:
    r=get(P,name)
    if r: cands.append([num(v) for v in (r.get('qty') or [])+[None]*N][:N])
  tot_read=[num(get(P,name)['total']) for P in runs if get(P,name)]
  tot=max(set(tot_read),key=tot_read.count) if tot_read else None
  # mỗi ô: các giá trị ứng viên khác nhau
  opts=[sorted(set(c[i] for c in cands),key=lambda v:(v is None,v)) for i in range(N)]
  pick=None
  amb=[i for i in range(N) if len(opts[i])>1]
  if len(amb)<=10:
    sols=[]
    for combo in itertools.product(*[opts[i] for i in amb]):
      row=[opts[i][0] for i in range(N)]
      for i,v in zip(amb,combo): row[i]=v
      if tot is not None and abs(sum(v or 0 for v in row)-tot)<1e-6: sols.append(row)
    if len(sols)==1: pick=sols[0]
    elif len(sols)>1:
      # ưu tiên ít ô trống nhất (lỗi hay gặp là bỏ sót)
      sols.sort(key=lambda r:sum(v is None for v in r)); 
      if sum(v is None for v in sols[0])<sum(v is None for v in sols[1]): pick=sols[0]
  cells+=N
  if pick:
    auto+=1; ok+=sum(a==b for a,b in zip(pick,truth))
    if pick!=truth: bad_auto+=1; print("TỰ KHỚP SAI:",name,pick,truth)
  else:
    review+=1; best=cands[0] if cands else [None]*N; ok+=sum(a==b for a,b in zip(best,truth))
    print("cần người xem:",name,"| tổng đọc",tot,"| đúng",total)
print(f"dòng tự khớp TỔNG: {auto}/{len(T['rows'])} (khớp nhưng sai: {bad_auto}); cần xem: {review}; ô đúng {ok}/{cells}")
