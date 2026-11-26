import sys,json
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGB'); W,H=im.size
LEFT=275  # TÊN NVL + ĐVT + TỔNG
cuts=json.loads(sys.argv[2]); rowsplit=json.loads(sys.argv[3]) if len(sys.argv)>3 else [[0,H]]
HEAD=(0,72)
out=[]
for ci,(x0,x1) in enumerate(cuts):
  for ri,(y0,y1) in enumerate(rowsplit):
    parts=[im.crop((0,HEAD[0],LEFT,HEAD[1])).copy()]
    w=LEFT+(x1-x0)
    t=Image.new('RGB',(w,(HEAD[1]-HEAD[0])+(y1-y0) if y0>0 else y1),'white')
    if y0>0:
      t.paste(im.crop((0,0,LEFT,HEAD[1])),(0,0)); t.paste(im.crop((x0,0,x1,HEAD[1])),(LEFT,0))
      t.paste(im.crop((0,y0,LEFT,y1)),(0,HEAD[1])); t.paste(im.crop((x0,y0,x1,y1)),(LEFT,HEAD[1]))
    else:
      t.paste(im.crop((0,0,LEFT,y1)),(0,0)); t.paste(im.crop((x0,0,x1,y1)),(LEFT,0))
    t=t.resize((t.width*3,t.height*3),Image.LANCZOS)
    fn=f'tile_{ci}_{ri}.png'; t.save(fn); out.append(fn)
print(json.dumps(out))
