#!/bin/bash
# Dựng DB local MỚI + chạy `wrangler dev` (ERP) ở nền + tạo tài khoản chủ, để chạy một bộ E2E.
# Dùng:  npm run build && bash scripts/e2e-db.sh .wrangler/e-hr 8791
#        BASE=http://localhost:8791 PERSIST=.wrangler/e-hr SHOTS=0 node e2e/hr.mjs
# Yêu cầu: file .dev.vars (không commit) có BOOTSTRAP_TOKEN dùng cho dev local.
# Tài khoản tạo ra: chu / mật khẩu mặc định của các bộ E2E (OWNER_PASS trong e2e/*.mjs).
# Dừng server: pkill -f "wrangler dev"
set -e
S=$1; P=$2
if [ -z "$S" ] || [ -z "$P" ]; then echo "Dùng: bash scripts/e2e-db.sh <thư mục state> <cổng>"; exit 1; fi
[ -f .dev.vars ] || { echo "Thiếu .dev.vars"; exit 1; }
[ -d dist/huu_manh_erp ] || { echo "Chưa build: chạy npm run build trước"; exit 1; }
# wrangler dev chạy bản build trong dist/ → .dev.vars phải nằm cạnh wrangler.json đã build
cp .dev.vars dist/huu_manh_erp/.dev.vars
rm -rf "$S"
npx wrangler d1 migrations apply huu-manh-erp --local --persist-to "$S" >/dev/null
for f in seed/seed.sql seed/seed-dot3.sql seed/seed-dot4.sql; do npx wrangler d1 execute huu-manh-erp --local --persist-to "$S" --file "$f" >/dev/null; done
npx wrangler d1 execute huu-manh-erp --local --persist-to "$S" --command "UPDATE stores SET lat=10.7769,lng=106.7009,geofence_m=150 WHERE id=1" >/dev/null
F=node_modules/@expo-google-fonts/be-vietnam-pro
npx wrangler r2 object put huu-manh-erp-files/fonts/BeVietnamPro-Regular.ttf --local --persist-to "$S" --file $F/400Regular/BeVietnamPro_400Regular.ttf >/dev/null 2>&1 || true
npx wrangler r2 object put huu-manh-erp-files/fonts/BeVietnamPro-Bold.ttf --local --persist-to "$S" --file $F/700Bold/BeVietnamPro_700Bold.ttf >/dev/null 2>&1 || true
nohup npx wrangler dev -c dist/huu_manh_erp/wrangler.json --port "$P" --inspector-port $((P+1000)) --persist-to "$S" > "$S.log" 2>&1 &
for i in $(seq 1 60); do curl -s "localhost:$P/api/auth/me" >/dev/null 2>&1 && break; sleep 1; done
TOK=$(grep -E '^BOOTSTRAP_TOKEN' .dev.vars | cut -d= -f2- | tr -d '"')
PASS=${OWNER_PASS:-ChuCuaHang-2026}
curl -s -X POST "localhost:$P/api/auth/bootstrap" -H 'content-type: application/json' -H "x-bootstrap-token: $TOK" \
  -d "{\"username\":\"chu\",\"password\":\"$PASS\",\"fullName\":\"Chủ cửa hàng\"}" | head -c 120; echo
