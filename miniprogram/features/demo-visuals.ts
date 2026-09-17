/** 仅精确映射演示 URI；不能给真实订单的缺失照片填充 AI 证据。 */
const DEMO_IMAGES: Record<string, string> = {
  'demo://photos/DEMO-SO-003.png': 'tower',
  'demo://photos/DEMO-SO-002.png': 'tower',
  'demo://photos/DEMO-RE-008.png': 'gpu',
  'demo://photos/DEMO-SO-011.png': 'tower',
  'demo://photos/DEMO-RE-006.png': 'laptop',
  'demo://photos/DEMO-SO-009.png': 'monitor',
  'demo://photos/DEMO-TR-001.png': 'tower',
}

export function demoVisual(photoUrl: string | null): { url: string | null; isIllustration: boolean } {
  const image = photoUrl ? DEMO_IMAGES[photoUrl] : undefined
  return image
    ? { url: `/assets/workbench/${image}.jpg`, isIllustration: true }
    : { url: photoUrl, isIllustration: false }
}
