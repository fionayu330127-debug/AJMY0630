const express = require('express');

const sampleSubmissionColumns = [
  'sample_status', 'listing_status', 'urgency', 'submit_date', 'developer',
  'lister', 'shipper', 'product_keywords', 'brand', 'store_name',
  'delivery_method', 'lead_time', 'variant_attribute', 'variant_name',
  'source_url', 'product_note', 'parent_asin_us', 'shipping_channel',
  'quantity', 'is_shipped', 'parent_asin_au', 'transparency_plan',
  'link_status', 'price_jp', 'contact_group', 'start_time', 'reference_text',
  'need_follow_sale', 'erp_listed', 'direct_review', 'ads_enabled',
  'copywriting_quality', 'a_plus',
];

const sampleStatusMap = {
  pending: '待审核',
  testing: '测品中',
  passed: '测品通过',
  failed: '测品失败',
  converted: '已转正式商品',
};

function normalizeSampleStatus(value) {
  const text = String(value || '').trim();
  if (Object.values(sampleStatusMap).includes(text)) return text;
  return sampleStatusMap[text] || '待审核';
}

function createOperationCenter({ query, getSessionUser, sendError }) {
  const router = express.Router();

  router.get('/sample-submissions', async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) return sendError(res, 401, '未登录');

    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || 'all').trim();
    const params = [];
    const whereParts = [];
    if (search) {
      params.push(`%${search}%`);
      whereParts.push(`(
        product_keywords ILIKE $${params.length}
        OR brand ILIKE $${params.length}
        OR store_name ILIKE $${params.length}
        OR product_note ILIKE $${params.length}
        OR source_url ILIKE $${params.length}
        OR variant_name ILIKE $${params.length}
      )`);
    }
    if (status && status !== 'all' && sampleStatusMap[status]) {
      params.push(sampleStatusMap[status]);
      whereParts.push(`COALESCE(sample_status, '待审核') = $${params.length}`);
    }
    const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const { rows: summaryRows } = await query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE COALESCE(sample_status, '待审核') = '待审核')::int AS pending,
        COUNT(*) FILTER (WHERE sample_status = '测品中')::int AS testing,
        COUNT(*) FILTER (WHERE sample_status = '测品通过')::int AS passed,
        COUNT(*) FILTER (WHERE sample_status = '测品失败')::int AS failed,
        COUNT(*) FILTER (WHERE sample_status = '已转正式商品')::int AS converted
      FROM product_sample_submissions
    `);

    const { rows } = await query(`
      SELECT s.*, u.name AS submitter_name, r.name AS reviewer_name
      FROM product_sample_submissions s
      LEFT JOIN users u ON u.id = s.submitter_id
      LEFT JOIN users r ON r.id = s.reviewer_id
      ${where}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 300
    `, params);

    res.json({ summary: summaryRows[0] || {}, submissions: rows });
  });

  router.post('/sample-submissions', async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) return sendError(res, 401, '未登录');

    const payload = {};
    for (const column of sampleSubmissionColumns) {
      payload[column] = String(req.body[column] || '').trim();
    }
    payload.sample_status = normalizeSampleStatus(payload.sample_status);
    if (!payload.product_keywords) return sendError(res, 400, '请输入产品关键词');
    if (!payload.brand) return sendError(res, 400, '请输入品牌');
    if (!payload.store_name) return sendError(res, 400, '请输入上架店铺');

    payload.submit_date = payload.submit_date && /^\d{4}-\d{2}-\d{2}$/.test(payload.submit_date)
      ? payload.submit_date
      : null;

    const columns = ['submitter_id', ...sampleSubmissionColumns];
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const values = [user.id, ...sampleSubmissionColumns.map((column) => payload[column])];
    const { rows } = await query(`
      INSERT INTO product_sample_submissions (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING *
    `, values);

    res.json({ ok: true, submission: { ...rows[0], submitter_name: user.name } });
  });

  router.patch('/sample-submissions/:id/status', async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) return sendError(res, 401, '未登录');

    const id = Number(req.params.id);
    if (!id) return sendError(res, 400, '记录不存在');

    const sampleStatus = normalizeSampleStatus(req.body.sample_status);
    const reviewNote = String(req.body.review_note || '').trim();
    const { rows } = await query(`
      UPDATE product_sample_submissions
      SET sample_status = $1,
          reviewer_id = $2,
          reviewed_at = now(),
          review_note = $3,
          updated_at = now()
      WHERE id = $4
      RETURNING *
    `, [sampleStatus, user.id, reviewNote, id]);

    if (!rows[0]) return sendError(res, 404, '测品记录不存在');
    res.json({ ok: true, submission: { ...rows[0], reviewer_name: user.name } });
  });

  return router;
}

module.exports = { createOperationCenter };
