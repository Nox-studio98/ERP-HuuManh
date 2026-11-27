-- Đợt 7: xoá nợ / chiết khấu công nợ ghi vào lãi lỗ theo NGÀY GHI SỔ (ngày duyệt), không theo ngày lập.
-- Chỉ thêm cột; dòng cũ: lấy ngày quyết định của phiếu duyệt nếu có, không thì ngày lập.
ALTER TABLE debt_adjustments ADD COLUMN posted_at TEXT;

UPDATE debt_adjustments
   SET posted_at = COALESCE((SELECT a.decided_at FROM approvals a WHERE a.id = debt_adjustments.approval_id AND a.status = 'approved'), created_at)
 WHERE status = 'posted' AND posted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_debt_adj_posted_at ON debt_adjustments(posted_at);
