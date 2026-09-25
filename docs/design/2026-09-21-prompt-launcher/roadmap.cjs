// 路线来自 04-delivery.md；历史记录仅为证据入口，不等于当前验收。
const row=(id,phase,title,goal,deps,files,record,prompt)=>({id,phase,title,goal,deps,files,record,prompt});
module.exports=[
row('E03','基础','界面与公共框架','让已有业务页面统一、好操作。',[],['frontend/src/styles/erp-polish.css','frontend/src/app/AppShell.tsx'],'docs/verification/2026-09-21-E03/README.md',7),
row('E02','基础','开发环境与协议','开发不碰生产，前后端遵循同一套业务协议。',[],['backend/scripts/dev-server.mjs','contracts/v1/actions.json'],'docs/verification/2026-09-19-E00/README.md',0),
row('E04','基础','客户、商品与库存','客户建档，商品和每件实物有清晰归属。',['E02'],['backend/src/routes/inventory-v2.ts','frontend/src/components/CustomersPage.tsx'],'docs/verification/2026-09-19-E04b-inventory/README.md',0),
row('E05','销售闭环','报价与客户确认','报价版本固定、能打印，并记录客户确认。',['E04'],['backend/src/routes/quote-v2.ts','frontend/src/features/workbench/WorkbenchQuotePage.tsx'],'docs/verification/2026-09-19-E05b-confirm/README.md',1),
row('E06','销售闭环','收款与库存预留','核实收到钱后预留；抢货失败也不能丢掉收款。',['E05'],['backend/src/domains/sale.ts','backend/src/routes/sales-v2.ts'],'docs/verification/2026-09-21-E06/README.md',1),
row('E07','销售闭环','采购与到货','缺货采购、分批到货、验收与退供。',['E04','E06'],['backend/src/domains/purchase.ts','backend/src/routes/purchase-v2.ts'],'docs/verification/2026-09-21-E07/README.md',2),
row('E08','销售闭环','装机、检测与交付','完成装机和检测，核对尾款；交付时扣库，支持直接零售。',['E06','E07'],[],'',1),
row('E09','销售闭环','取消、退货与退款','取消释放库存；退货和退款分别留痕，钱账能核对。',['E08'],[],'',5),
row('E10','完整 ERP','售后维修','接机、检测、报价授权、用料、复测、返还设备。',['E04','E08','E09'],['backend/src/domains/service.ts','backend/src/routes/service-v2.ts'],'',3),
row('E11','完整 ERP','回收与拆件','收回旧机，拆件检测、分摊成本、追溯入库。',['E04','E09'],['backend/src/domains/recovery.ts','backend/src/routes/recovery-v2.ts'],'',4),
row('E12','完整 ERP','置换与抵用额度','关联销售和回收；额度可分次使用，余额和撤销有账。',['E05','E06','E09','E11'],['backend/src/domains/credit.ts'],'',4),
row('E13','完整 ERP','盘点与经营账本','库存差异可追溯，现金、折抵、成本、毛利分开核对。',['E09','E10','E11','E12'],['backend/src/domains/ledger.ts'],'',5),
row('E14','营业验收','完整首版验收','所有业务接通，再做迁移预检、恢复演练与现场验收。',['E08','E09','E10','E11','E12','E13'],[],'',8),
row('C01','顾客端','顾客小程序','顾客专属报价、确认下单、真实支付和进度查询。',['E14'],['miniprogram/app.json'],'',6)
];
