/*
 * 原型演示数据 —— 全部是虚构示例，不代表任何门店的真实库存、成本或客户。
 * 唯一用途：说明操作顺序与状态口径。原型刷新即重置，不做任何持久化。
 *
 * 状态口径（与方案 README 第 2、4 节一致）：
 *   检测情况 = 待检测 / 已检测正常 / 有问题      —— 事实，由店员记录
 *   库存状态 = 可售 / 已预留 / 待检测 / 待处理    —— 由检测事实与占用推导，不单独录入
 * 「新品 / 二手」和「待检测 / 已检测正常 / 有问题」是两组互不相干的信息。
 */
window.DEMO = {
  /* 能独立交易或售后的主要配件：默认逐件记录 */
  perItemCategories: ['CPU', '显卡', '主板', '内存', '硬盘', '电源'],

  categories: ['CPU', '显卡', '主板', '内存', '硬盘', '散热器', '电源', '机箱'],
  moreCategories: ['显示器', '键鼠', '线材', '其他'],

  statusFilters: [
    { key: 'all', label: '全部在库' },
    { key: 'available', label: '可售' },
    { key: 'reserved', label: '已预留' },
    { key: 'inspecting', label: '待检测' },
    { key: 'handling', label: '待处理' },
  ],

  /* 常用来源：通用入口不预选，业务页面进入才带入 */
  sources: [
    { key: 'opening', label: '店里已有', hint: '开店前或已整理上架的自有配件' },
    { key: 'purchase', label: '新买到货', hint: '已经买到手，按实际付款和来源登记' },
    { key: 'recovery', label: '回收或置换', hint: '顾客拿来出售或置换，要先走回收确认' },
    { key: 'teardown', label: '整机拆件', hint: '整机拆出的配件，保留源设备关联' },
  ],

  inspections: [
    { key: 'pending', label: '待检测' },
    { key: 'ok', label: '已检测正常' },
    { key: 'faulty', label: '有问题' },
  ],

  /* 更多视图：都不计入自有在库 */
  moreViews: [
    { key: 'custody', label: '客户暂存' },
    { key: 'in_transit', label: '在途' },
    { key: 'sold', label: '已售记录' },
  ],

  moreTools: [
    { key: 'activity', label: '操作记录' },
    { key: 'count', label: '盘点库存' },
    { key: 'library', label: '商品档案' },
    { key: 'cleanup', label: '清理工具' },
  ],

  /*
   * 每件配件一条记录。bucket 与 inspection 是两件事：
   *   bucket      = 实物在店里处于哪个位置（可售 / 已预留 / 隔离 / 客户暂存 / 在途 / 已售）
   *   inspection  = 检测事实（待检测 / 已检测正常 / 有问题）
   * 列表上显示的「库存状态」由两者推导，见 app.js 的 statusOf()。
   */
  items: [
    {
      id: 'it-01', code: 'CPU-260926-001', category: 'CPU', model: 'i5-12400F', specs: '散片',
      brand: 'Intel', condition: 'used', inspection: 'ok', faultNote: '', bucket: 'available',
      reservedRef: null, costCents: 43000, costBasis: 'actual',
      remark: '正常，无维修，触点干净', source: 'opening', sourceNote: '开店前存量',
      sn: null, acquiredAt: '2026-09-26',
    },
    {
      id: 'it-02', code: 'CPU-260927-002', category: 'CPU', model: 'i5-12400F', specs: '带原包装',
      brand: 'Intel', condition: 'used', inspection: 'pending', faultNote: '', bucket: 'quarantine',
      reservedRef: null, costCents: 46000, costBasis: 'actual',
      remark: '带包装，还没上机', source: 'opening', sourceNote: '开店前存量',
      sn: null, acquiredAt: '2026-09-27',
    },
    {
      id: 'it-03', code: 'GPU-260927-003', category: '显卡', model: 'RTX 3060 12G', specs: '双风扇',
      brand: '影驰', condition: 'used', inspection: 'faulty', faultNote: '高负载时风扇异响',
      bucket: 'quarantine', reservedRef: null, costCents: 68000, costBasis: 'actual',
      remark: '风扇异响，待处理', source: 'purchase', sourceNote: '本地同行',
      sn: 'SN3060A00317', acquiredAt: '2026-09-27',
    },
    {
      id: 'it-04', code: 'MB-260925-004', category: '主板', model: 'B760M-PLUS', specs: 'D4',
      brand: '华硕', condition: 'used', inspection: 'ok', faultNote: '', bucket: 'available',
      reservedRef: null, costCents: 32000, costBasis: 'actual',
      remark: '挡板齐全', source: 'opening', sourceNote: '开店前存量',
      sn: null, acquiredAt: '2026-09-25',
    },
    {
      id: 'it-05', code: 'GPU-260926-005', category: '显卡', model: 'RTX 4060 Ti 8G', specs: '金属大师',
      brand: '影驰', condition: 'used', inspection: 'ok', faultNote: '', bucket: 'reserved',
      reservedRef: '报价 Q-260926-014', costCents: 145000, costBasis: 'actual',
      remark: '已检测正常，客户已付定金', source: 'recovery', sourceNote: '顾客置换',
      sn: 'SN4060T01982', acquiredAt: '2026-09-26',
    },
    {
      id: 'it-06', code: 'MEM-260924-006', category: '内存', model: 'DDR4 16G 3200', specs: '8G×2 套条',
      brand: '金士顿', condition: 'used', inspection: 'ok', faultNote: '', bucket: 'available',
      reservedRef: null, costCents: 9500, costBasis: 'actual',
      remark: '', source: 'opening', sourceNote: '开店前存量',
      sn: null, acquiredAt: '2026-09-24',
    },
    {
      id: 'it-07', code: 'SSD-260927-007', category: '硬盘', model: '1TB NVMe', specs: 'PCIe 3.0',
      brand: '三星', condition: 'used', inspection: 'pending', faultNote: '', bucket: 'quarantine',
      reservedRef: null, costCents: 18000, costBasis: 'actual',
      remark: '待读健康度', source: 'teardown', sourceNote: '整机拆件 源设备 ZJ-260927-01',
      sn: null, acquiredAt: '2026-09-27',
    },
    {
      id: 'it-08', code: 'PSU-260923-008', category: '电源', model: '650W 金牌', specs: '全模组',
      brand: '振华', condition: 'used', inspection: 'ok', faultNote: '', bucket: 'available',
      reservedRef: null, costCents: 21000, costBasis: 'actual',
      remark: '', source: 'opening', sourceNote: '开店前存量',
      sn: null, acquiredAt: '2026-09-23',
    },
    {
      id: 'it-09', code: 'CPU-260927-009', category: 'CPU', model: 'R5 5600', specs: '散片',
      brand: 'AMD', condition: 'used', inspection: 'ok', faultNote: '', bucket: 'available',
      reservedRef: null, costCents: null, costBasis: 'unknown',
      remark: '成本待确认', source: 'opening', sourceNote: '开店前存量',
      sn: null, acquiredAt: '2026-09-27',
    },
  ],

  /* 更多视图里的记录：客户暂存是他人财产，在途还没到手，已售已离开在库 */
  sideItems: [
    {
      id: 'side-01', code: 'GPU-260926-101', category: '显卡', model: 'RTX 2070 8G', specs: '',
      brand: '', condition: 'used', inspection: 'pending', faultNote: '', bucket: 'custody',
      reservedRef: null, costCents: null, costBasis: 'unknown', remark: '顾客寄放待定，未收购',
      source: 'recovery', sourceNote: '客户 张先生', sn: null, acquiredAt: '2026-09-26',
    },
    {
      id: 'side-02', code: 'CPU-260927-102', category: 'CPU', model: 'i7-13700F', specs: '盒装',
      brand: 'Intel', condition: 'new', inspection: 'pending', faultNote: '', bucket: 'in_transit',
      reservedRef: null, costCents: 168000, costBasis: 'actual', remark: '采购单 PO-260927-03 已下单，未到货',
      source: 'purchase', sourceNote: '线上商家', sn: null, acquiredAt: '2026-09-27',
    },
    {
      id: 'side-03', code: 'MEM-260910-103', category: '内存', model: 'DDR5 32G 6000', specs: '单条',
      brand: '威刚', condition: 'new', inspection: 'ok', faultNote: '', bucket: 'sold',
      reservedRef: '报价 Q-260910-006', costCents: 42000, costBasis: 'actual', remark: '已交付',
      source: 'purchase', sourceNote: '线上商家', sn: 'SN5D5K88121', acquiredAt: '2026-09-10',
    },
  ],

  /* 方案第 5 节要求清掉的旧文案：原型里作为对照保留，标注「已删除」 */
  removedCopy: [
    '实物收进来，或确认交出去',
    '所有金额由服务端按整数分结算',
    '还没有商品档案',
  ],
};
