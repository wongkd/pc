/** Display-only demo assets. Never replace a missing real attachment with generated evidence. */
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
    ? { url: `${import.meta.env.BASE_URL}assets/workbench/${image}.jpg`, isIllustration: true }
    : { url: photoUrl, isIllustration: false }
}
